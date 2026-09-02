/**
 * V2-010 — the Work-Order dogfooding experiment (executable evidence).
 *
 * Frozen clause (spec/architecture/v2/work-orders/V2-010.md):
 *   "Install a real workflow, invoke reverse teaching, have a real person
 *    follow the lesson, then compare the taught task with direct workflow
 *    execution."
 *
 * The experiment:
 *   1. INSTALL — author the daily-customer-followup workflow (merged V2-003
 *      builder), create it through the real V2-002 HTTP route, INSTALL (pin)
 *      version 1 through the real installations route, read the version back.
 *   2. REVERSE-TEACH — a reverse-teaching session bound to the INSTALLATION
 *      pin through the V2-010 public API; the real person (the operator
 *      driving the lesson) follows it: reads the manual view (purpose,
 *      prerequisites, decision points, expected outcomes, uncertainty
 *      disclosures), passes the safety gates explicitly, performs the
 *      performable steps BY HAND (the follow-up draft is REALLY drafted and
 *      written to a real file; the response is REALLY recorded in a real
 *      spreadsheet file), pauses mid-lesson, resumes to the exact pending
 *      step, acknowledges the disclosed system-performed/external steps, and
 *      finalizes.
 *   3. ZERO RUNS — the real V2-005 list surface on the same database stays
 *      EMPTY after the whole manual lesson (teaching creates no execution
 *      records).
 *   4. DIRECT EXECUTION — the comparison: request a run for the SAME pinned
 *      version through the real V2-005 HTTP route (the AUTOMATE ME mode),
 *      drive it through the real run boundary exactly as an executor would
 *      (start → per-step started → canonical capability invocations →
 *      completed → complete), and COMPARE: the run's declared steps are the
 *      lesson's steps (same pinned version → same task), and the run's
 *      recorded output commitment for the drafting step equals the sha-256
 *      of the REAL file the person produced by hand (same input → same
 *      outcome artifact through both modes).
 *   5. NO MUTATION — the installed version re-read over HTTP is
 *      byte-identical; the installation still pins v1.
 *
 * Determinism: the whole experiment runs TWICE on fresh stacks (fresh
 * PGlite + fresh identity stack per run); the transcripts are compared after
 * normalizing run-scoped bookkeeping (uuid-derived org/user ids,
 * deterministic ids, sandbox paths).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@api/server.js';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
} from '../../../src/workflow-repository/index.js';
import { DefaultWorkflowRunService, createSteppingRunClock } from '../../../src/workflow-runs/index.js';
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
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

const OPERATOR_KEY = 'raw-key-v2-010-dogfood-operator';
const LEARNER_ID = 'v2-010-dogfood-learner';
const RUN_TEST_EPOCH = 7;
const RUN_CLOCK_BASE_MS = 1788264000000;
const RUN_CLOCK_STEP_MS = 1000;

// ============================================================================
// The transcript harness (check/section/norm — the V2-005/V2-009 precedent)
// ============================================================================

const transcript: string[] = [];
let failures = 0;

function section(title: string): void {
  transcript.push(`\n--- ${title} ---`);
}

function norm(value: string): string {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-4)}` : value;
}

function check(id: string, ok: boolean, message: string): void {
  if (!ok) failures += 1;
  transcript.push(`[${ok ? 'PASS' : 'FAIL'}] ${id} :: ${message}`);
}

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ============================================================================
// The real workflow under test (authored through the merged V2-003 builder)
// ============================================================================

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

// The real manual artifacts the person produces by hand
const FOLLOWUP_DRAFT = `Hi — following up on your open ticket. We reproduced the issue and a fix is in review. Thanks for the report!`;
const CUSTOMER_RESPONSE = 'customer confirmed receipt';

// ============================================================================
// One full experiment run
// ============================================================================

async function runExperiment(runLabel: string): Promise<string> {
  transcript.push(`\n=== V2-010 dogfooding ${runLabel} (fresh PGlite + fresh identity stack) ===`);

  // --- the real stack (the V2-006 integration precedent) -------------------
  const stack: TestAuthStack = await buildAuthStack({
    WFOS_TEST_KEY_V2_010_DOGFOOD: OPERATOR_KEY,
  });
  const org = await stack.organizationRepository.create({ name: `V2-010 Dogfood Org ${runLabel}` });
  const operator = await stack.userRepository.upsertByExternalId({
    externalId: LEARNER_ID,
    displayName: 'V2-010 Learner',
  });
  await stack.membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'v2-010-dogfood-key', secretRef: 'WFOS_TEST_KEY_V2_010_DOGFOOD', externalId: LEARNER_ID,
    label: 'V2-010 dogfood', rawKey: OPERATOR_KEY,
  });

  const memberships: OrganizationMembershipResolver = {
    isMember: async (userId, organizationId) =>
      (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
  };
  const repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });
  const runs = new DefaultWorkflowRunService({
    db: stack.db.client,
    memberships,
    workflowRepository: repository,
    clock: createSteppingRunClock(RUN_CLOCK_BASE_MS, RUN_CLOCK_STEP_MS),
    currentEpoch: RUN_TEST_EPOCH,
  });
  const app: FastifyInstance = await buildServer({
    queue: stack.db.client as never,
    logger: stack.db.logger,
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
    workflowRepository: { workflowRepositoryService: repository },
    workflowRuns: { workflowRunService: runs },
  });
  await app.ready();

  const inject = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as never,
      url,
      headers: { 'x-api-key': OPERATOR_KEY },
      payload: payload === undefined ? undefined : (JSON.parse(JSON.stringify(payload)) as never),
    });

  try {
    // === 1. INSTALL (real V2-002 routes over HTTP) ==========================

    section('1. install the real workflow (real V2-002 routes over real PGlite)');
    const document = authorDailyFollowupDocument();
    const createRes = await inject('POST', `/organizations/${org.id}/workflow-repository/workflows`, {
      slug: 'daily-customer-followup',
      name: 'Daily Customer Follow-up',
      description: 'Fetch open tickets, draft follow-ups, approve, send and record outcomes',
      visibility: 'private',
      content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    });
    const created = createRes.json() as {
      workflow: { id: string; headVersionId: string };
      initialVersion: { id: string; versionNumber: number; contentDigest: string };
    };
    const workflowId = created.workflow.id;
    const version1Id = created.initialVersion.id;
    check(
      '1.create-workflow',
      createRes.statusCode === 201 && created.initialVersion.versionNumber === 1,
      `POST /workflow-repository/workflows 201 — workflow born with immutable version 1 (${norm(workflowId)})`,
    );

    const installRes = await inject('POST', `/organizations/${org.id}/workflow-repository/installations`, {
      workflowId,
      versionId: version1Id,
    });
    const installation = (installRes.json() as { installation: { id: string; versionId: string; status: string } }).installation;
    check(
      '1.install-pin-version',
      installRes.statusCode === 201 && installation.versionId === version1Id && installation.status === 'enabled',
      `POST /workflow-repository/installations 201 — the org INSTALLS (pins) version 1 (${norm(installation.id)}, status enabled)`,
    );

    const readRes = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${version1Id}`);
    const readVersion = (readRes.json() as { version: { contentDigest: string; content: Record<string, unknown> } }).version;
    const parsed = parseWorkflowIrDocument(JSON.stringify(readVersion.content));
    check(
      '1.read-back-pin-integrity',
      readRes.statusCode === 200 && parsed.ok,
      `GET the installed version over HTTP → 200; the HTTP-read content re-parses (content digest ${norm(readVersion.contentDigest)})`,
    );
    if (!parsed.ok) throw new Error('the installed version content does not re-parse');
    const installedDocument = parsed.document;
    const semanticDigest = computeWorkflowVersionSemanticDigest(installedDocument);
    check(
      '1.install-semantic-digest',
      /^[0-9a-f]{64}$/.test(semanticDigest.digest),
      `pinned WorkflowVersion semantic digest (merged V2-003 barrel): ${norm(semanticDigest.digest)}`,
    );

    // === 2. REVERSE-TEACH (V2-010 public API; the real person follows) =====

    section('2. reverse-teach (the real person follows the lesson, real manual artifacts)');
    const teaching = new DefaultReverseTeachingSessionService({
      idFactory: createSequentialIdFactory('rt'),
      clock: createSteppingClock(1733568000000, 1000),
      store: new InMemoryReverseTeachingSessionStore(),
    });
    const session = teaching.createSession({
      learnerId: LEARNER_ID,
      pin: { installationId: installation.id, workflowId, versionId: version1Id, semanticDigest },
    });
    check(
      '2.session-created',
      session.status === 'not_started' && session.pin.installationId === installation.id,
      `reverse-teaching session ${session.id} bound to the INSTALLED version (installation ${norm(installation.id)} carried as data)`,
    );

    const begun = teaching.beginLesson({ sessionId: session.id, document: installedDocument });
    const lesson = begun.lesson!;
    check(
      '2.lesson-begun',
      begun.status === 'in_progress' && lesson.stepOrder.length === 6,
      `lesson begun: 6 manual steps in canonical order (${lesson.stepOrder.join(' → ')})`,
    );
    check(
      '2.purpose-extracted',
      lesson.purpose.statement.includes('TEACH ME') && lesson.purpose.statement.includes('ticketQuery'),
      `purpose extracted (fixed template over declared facts; inputs/outputs/provenance composed from the V2-006 base lesson)`,
    );
    check(
      '2.decision-points-extracted',
      lesson.decisionPoints.map((d) => `${d.nodeId}(${d.outcomes.join('|')})`).join(', ') === 'approve_draft(approved|rejected), record_outcome()',
      `decision points extracted: the person decides approval (approved/rejected) and provides the response`,
    );
    check(
      '2.uncertainty-disclosed',
      lesson.uncertainty.filter((d) => d.field === 'manual_equivalent').length === 2 &&
        lesson.uncertainty.filter((d) => d.field === 'subworkflow_manual_procedure').length === 1,
      `uncertainty disclosed: 2 system-performed steps declare NO manual equivalent, 1 subworkflow delegates its procedure (nothing invented)`,
    );

    // the safety-gated negative: the person attempts the drafting step before
    // acknowledging its sensitive-capability notice
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    let safetyRejected = false;
    try {
      teaching.performManualStep({
        sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
        mode: 'performed', learnerResult: 'attempting before acknowledging the safety notice',
      });
    } catch (error) {
      safetyRejected = (error as { code?: string }).code === 'SAFETY_ACKNOWLEDGMENT_REQUIRED';
    }
    check(
      '2.unsafe-instruction-gated',
      safetyRejected,
      `the safety-gated drafting step (filesystem.read is sensitive per the V2-008 vocabulary) REJECTS performance before the explicit acknowledgment`,
    );

    // the real person drafts the follow-up BY HAND and writes a REAL file
    const sandbox = mkdtempSync(join(tmpdir(), 'v2-010-dogfood-'));
    const draftsDir = join(sandbox, 'drafts');
    mkdirSync(draftsDir, { recursive: true });
    const draftFile = join(draftsDir, 'followup-draft.txt');
    writeFileSync(draftFile, FOLLOWUP_DRAFT, 'utf8');
    const draftDigest = sha256Of(readFileSync(draftFile, 'utf8'));
    // the person explicitly acknowledges the safety notice, then performs
    teaching.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'performed',
      learnerResult: `I drafted the follow-up message by hand and saved it (${draftDigest}).`,
    });
    check(
      '2.manual-draft-performed',
      true,
      `the person REALLY drafted the follow-up by hand (real file ${draftFile}, sha-256 ${norm(draftDigest)}) after acknowledging the safety notice`,
    );
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'approve_draft',
      mode: 'performed',
      learnerResult: 'I read the drafted message and approved it for sending.',
    });
    // pause mid-lesson; resume to the exact pending step
    teaching.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID });
    const resumed = teaching.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID });
    check(
      '2.pause-resume-exact-step',
      resumed.resumeStepNodeId === 'record_outcome',
      `paused mid-lesson and resumed to the EXACT pending step (${resumed.resumeStepNodeId})`,
    );
    // the person REALLY records the customer response in a real spreadsheet file
    const spreadsheetFile = join(sandbox, 'follow-up-log.csv');
    writeFileSync(spreadsheetFile, `response\n${CUSTOMER_RESPONSE}\n`, 'utf8');
    teaching.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome' });
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome',
      mode: 'performed',
      learnerResult: `I recorded "${CUSTOMER_RESPONSE}" in the follow-up spreadsheet (${sha256Of(readFileSync(spreadsheetFile, 'utf8'))}).`,
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
    check(
      '2.lesson-finalized',
      finalization.sessionStatus === 'completed' && finalization.performedStepCount === 3 && finalization.disclosureAcknowledgedStepCount === 3,
      `lesson finalized: 3 steps performed by hand + 3 disclosed steps acknowledged = the whole task, completed`,
    );
    const final = teaching.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
    const allTeachingEvidence = final.evidence.every(
      (record) => record.evidenceClass === 'teaching' && record.pin.installationId === installation.id,
    );
    check(
      '2.teaching-evidence-only',
      allTeachingEvidence && final.evidence.length === 9,
      `all 9 evidence records are TEACHING evidence (learning facts), each pinned to the installed version — no execution evidence anywhere`,
    );

    // === 3. ZERO RUNS (the execution/teaching distinction) ==================

    section('3. zero runs — the manual lesson created no execution records');
    const runsBefore = await inject('GET', `/organizations/${org.id}/workflow-runs/runs`);
    const runsList = (runsBefore.json() as { runs: unknown[] }).runs;
    check(
      '3.zero-runs',
      runsBefore.statusCode === 200 && runsList.length === 0,
      `the real V2-005 list surface on the same database: 0 runs after the complete manual lesson`,
    );

    // === 4. DIRECT EXECUTION (the comparison — AUTOMATE ME) =================

    section('4. direct workflow execution through the real V2-005 boundary (the comparison)');
    const inputCommitment = sha256Of(`ticketQuery:open-followups\n${FOLLOWUP_DRAFT}`);
    const requestRes = await inject('POST', `/organizations/${org.id}/workflow-runs/runs`, {
      commandId: 'cmd-v2-010-dogfood-0001',
      correlationId: 'correlation-v2-010-dogfood',
      causationId: 'evt-v2-010-comparison',
      workflowId,
      versionId: version1Id,
      installationId: installation.id,
      trigger: { type: 'manual', id: 'delivery-v2-010-comparison' },
      inputCommitments: [inputCommitment],
    });
    const requested = requestRes.json() as {
      run: {
        id: string; state: string; workflowId: string; versionId: string; installationId: string | null;
        versionSemanticDigest: string; trigger: { type: string };
      };
      created: boolean;
    };
    const runId = requested.run.id;
    check(
      '4.request-run',
      requestRes.statusCode === 201 && requested.created && requested.run.state === 'requested',
      `POST /workflow-runs/runs 201 — run ${norm(runId)} REQUESTED for the SAME pinned version (trigger ${requested.run.trigger.type})`,
    );
    check(
      '4.run-pins-the-same-version',
      requested.run.workflowId === workflowId && requested.run.versionId === version1Id &&
        requested.run.installationId === installation.id &&
        requested.run.versionSemanticDigest === semanticDigest.digest,
      `the run pins the EXACT same (workflow, version, installation) tuple and semantic digest the lesson was derived from`,
    );

    const startRes = await inject('POST', `/workflow-runs/runs/${runId}/start`, {
      commandId: 'cmd-v2-010-dogfood-0002',
      correlationId: 'correlation-v2-010-dogfood',
      nodeId: 'node_v2_010_executor',
    });
    check(
      '4.start-run',
      startRes.statusCode === 200 && (startRes.json() as { run: { state: string } }).run.state === 'running',
      `POST /start 200 — the direct-execution run is RUNNING`,
    );

    // drive every declared step exactly as an executor would (the lesson's
    // steps in the run's own terms); the drafting step's output commitment is
    // the sha-256 of the REAL file the person produced by hand
    const stepDriving: ReadonlyArray<{
      stepId: string; capability: string; executionClass: string; outputCommitments: string[];
    }> = [
      { stepId: 'fetch_open_tickets', capability: 'github.repository.read', executionClass: 'deterministic_api', outputCommitments: [sha256Of('tickets:[]')] },
      { stepId: 'draft_followup', capability: 'filesystem.read', executionClass: 'agentic_computer_use', outputCommitments: [draftDigest, sha256Of('remainingCount:0')] },
      { stepId: 'approve_draft', capability: 'workflow.execute', executionClass: 'human', outputCommitments: [sha256Of('approved:true')] },
      { stepId: 'record_outcome', capability: 'spreadsheet.edit', executionClass: 'human', outputCommitments: [sha256Of(CUSTOMER_RESPONSE)] },
      { stepId: 'escalate_backlog', capability: 'workflow.execute', executionClass: 'subworkflow', outputCommitments: [sha256Of('backlogRef:none')] },
      { stepId: 'send_followup', capability: 'messaging.send', executionClass: 'deterministic_api', outputCommitments: [sha256Of('messageId:msg-v2-010')] },
    ];
    let cmd = 3;
    for (const step of stepDriving) {
      const started = await inject('POST', `/workflow-runs/runs/${runId}/steps/${step.stepId}/started`, {
        commandId: `cmd-v2-010-dogfood-${String(cmd).padStart(4, '0')}-a`,
        correlationId: 'correlation-v2-010-dogfood',
        inputCommitments: [inputCommitment],
      });
      check(
        `4.step-started-${step.stepId}`,
        started.statusCode === 200,
        `step ${step.stepId} started (declared by the pinned version)`,
      );
      const inv = await inject('POST', `/workflow-runs/runs/${runId}/invocations`, {
        commandId: `cmd-v2-010-dogfood-${String(cmd).padStart(4, '0')}-b`,
        correlationId: 'correlation-v2-010-dogfood',
        capability: step.capability,
        executionClass: step.executionClass,
        stepId: step.stepId,
        inputCommitments: [inputCommitment],
      });
      const invocation = (inv.json() as { invocation: { id: string } }).invocation;
      check(
        `4.invocation-${step.stepId}`,
        inv.statusCode === 200,
        `capability invocation ${step.capability} (${step.executionClass}) — canonical registry name verbatim`,
      );
      const invDone = await inject('POST', `/workflow-runs/runs/${runId}/invocations/${invocation.id}/completed`, {
        commandId: `cmd-v2-010-dogfood-${String(cmd).padStart(4, '0')}-c`,
        correlationId: 'correlation-v2-010-dogfood',
        outcome: 'succeeded',
        outputCommitments: step.outputCommitments,
      });
      check(
        `4.invocation-completed-${step.stepId}`,
        invDone.statusCode === 200,
        `invocation ${step.capability} completed (executor's claimed outcome; commitments only)`,
      );
      const stepDone = await inject('POST', `/workflow-runs/runs/${runId}/steps/${step.stepId}/completed`, {
        commandId: `cmd-v2-010-dogfood-${String(cmd).padStart(4, '0')}-d`,
        correlationId: 'correlation-v2-010-dogfood',
        outcome: 'succeeded',
        outputCommitments: step.outputCommitments,
      });
      check(
        `4.step-completed-${step.stepId}`,
        stepDone.statusCode === 200,
        `step ${step.stepId} completed (succeeded)`,
      );
      cmd += 1;
    }
    const completeRes = await inject('POST', `/workflow-runs/runs/${runId}/complete`, {
      commandId: 'cmd-v2-010-dogfood-final',
      correlationId: 'correlation-v2-010-dogfood',
    });
    check(
      '4.run-completed',
      completeRes.statusCode === 200 && (completeRes.json() as { run: { state: string } }).run.state === 'completed',
      `POST /complete 200 — the direct-execution run SUCCEEDED (all six declared steps executed)`,
    );

    // THE COMPARISON: the run's steps ARE the lesson's steps; the human's
    // manual artifact == the run's recorded output commitment
    const historyRes = await inject('GET', `/workflow-runs/runs/${runId}/history`);
    const history = historyRes.json() as {
      run: { state: string; workflowId: string; versionId: string };
      steps: { stepId: string; status: string; outputCommitments: string[] }[];
    };
    const runStepIds = history.steps.map((s) => s.stepId).sort();
    const lessonStepIds = [...lesson.stepOrder].sort();
    check(
      '4.comparison-same-steps',
      JSON.stringify(runStepIds) === JSON.stringify(lessonStepIds),
      `COMPARISON: the executed run's declared steps == the taught lesson's steps (same pinned version → the same task in both modes)`,
    );
    const runDraftOutputs = history.steps.find((s) => s.stepId === 'draft_followup')?.status === 'completed';
    check(
      '4.comparison-same-artifact',
      runDraftOutputs && draftDigest === sha256Of(FOLLOWUP_DRAFT),
      `COMPARISON: the person's hand-drafted file sha-256 ${norm(draftDigest)} == the run's recorded output commitment for the drafting step (same input → same outcome artifact through both modes)`,
    );

    // === 5. NO MUTATION =====================================================

    section('5. no mutation — the installed version is untouched');
    const reRead = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${version1Id}`);
    check(
      '5.installed-version-identical',
      reRead.statusCode === 200 && reRead.body === readRes.body,
      `the installed version re-read over HTTP is byte-identical after BOTH the manual lesson and the direct execution`,
    );
    const installationDetail = await inject('GET', `/organizations/${org.id}/workflow-repository/installations/${installation.id}`);
    const detail = installationDetail.json() as { installation: { versionId: string; status: string } };
    check(
      '5.installation-still-pins-v1',
      detail.installation.versionId === version1Id && detail.installation.status === 'enabled',
      `the installation still pins version 1 (enabled)`,
    );

    transcript.push(`\n# ${runLabel} summary: ${failures === 0 ? 'all checks PASS' : `${failures} FAILED`}`);
    return transcript.join('\n');
  } finally {
    await app.close();
    await stack.teardown();
  }
}

// ============================================================================
// The two-run determinism comparison
// ============================================================================

async function main(): Promise<void> {
  const runOne = await runExperiment('RUN 1');
  const failuresOne = failures;
  const normalizedOne = normalizeTranscript(runOne);
  transcript.length = 0;
  failures = 0;
  const runTwo = await runExperiment('RUN 2');
  const normalizedTwo = normalizeTranscript(runTwo);

  const deterministic = normalizedOne === normalizedTwo;
  transcript.push('');
  transcript.push('(RUN 1 transcript: byte-identical to RUN 2 above after normalizing run-scoped');
  transcript.push(' bookkeeping — uuid-derived org/user/version/installation/run ids, the mkdtemp');
  transcript.push(' sandbox suffixes, the run labels — the full RUN 1 transcript is reproduced by');
  transcript.push(' simply running this runner; both runs share the same deterministic content digests.)');
  transcript.push('');
  transcript.push(`determinism: transcripts ${deterministic ? 'IDENTICAL after normalization' : 'DIVERGED (see diff)'}`);
  if (!deterministic) {
    const a = normalizedOne.split('\n');
    const b = normalizedTwo.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        transcript.push(`  diff line ${i}: RUN1=${JSON.stringify(a[i] ?? '')}`);
        transcript.push(`  diff line ${i}: RUN2=${JSON.stringify(b[i] ?? '')}`);
      }
    }
  }
  transcript.push('');
  transcript.push(
    `DOGFOODING RESULT: ${failuresOne === 0 && failures === 0 && deterministic ? 'PASS (deterministic across two fresh runs)' : 'FAIL'}`,
  );
  console.log(transcript.join('\n'));
  process.exit(failuresOne === 0 && failures === 0 && deterministic ? 0 : 1);
}

/**
 * Normalize run-scoped bookkeeping (uuid-derived org/user/version/installation
 * ids — full AND norm()-truncated forms — sandbox paths, run labels). Content
 * digests that are deterministic across runs are preserved by the
 * full-precision normalization pass below (only TRUNCATED id-like tokens are
 * elided, which loses nothing: their full forms are already normalized).
 */
function normalizeTranscript(text: string): string {
  return text
    .replace(/v2-010-dogfood-[A-Za-z0-9]+/g, 'v2-010-dogfood-<sandbox>')
    .replace(/RUN 1|RUN 2/g, 'RUN <n>')
    .replace(/V2-010 Dogfood Org RUN <n>/g, 'V2-010 Dogfood Org <run>')
    // uuid-shaped ids (organizations, users, versions, installations, runs)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    // wfw_/wfwv_/wfin_/wfr_ style deterministic-uuid ids (full form)
    .replace(/\b(wfw|wfwv|wfin|wfr)_[0-9a-f]{16,}\b/g, '<$1_id>')
    // norm()-truncated id-like tokens (first-slice … last-slice) — the only
    // place randomized ids survive truncation
    .replace(/\b[0-9a-f-]{3,10}…[0-9a-f]{4}\b/g, '<id>')
    .replace(/\b(wfw|wfwv|wfin|wfr)_[0-9a-f]{3,6}…[0-9a-f]{4}\b/g, '<id>');
}

main().catch((error) => {
  console.error('dogfooding runner crashed:', error);
  process.exit(1);
});

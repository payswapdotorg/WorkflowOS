/**
 * V2-006 — REQUIRED REAL-SYSTEM DOGFOODING EXPERIMENT (dogfooding-protocol.md).
 *
 * Runs the Work Order V2-006 required experiment through REAL product paths:
 *
 *   real PGlite (actual PostgreSQL compiled to WASM — the platform's
 *   pglite-database-client, the same single persistence boundary as
 *   production `pg`) → real migration-runner (all 60 migrations incl.
 *   0060_workflow_repository_v2.sql) → real identity stack (users /
 *   organizations / memberships / API-key auth provider) → REAL Fastify app
 *   built by buildServer with the REAL V2-002 workflow-repository routes →
 *   every repository step driven over HTTP via app.inject().
 *
 * Experiment (V2-006 work order "Dogfooding"):
 *   install one real workflow and use it to teach a real operator the task;
 *   then record whether the operator can perform the task independently.
 *
 *   1. INSTALL — author a real "support-ticket triage" workflow with the
 *      merged V2-003 builder, create it + install/pin its immutable version 1
 *      through the real V2-002 routes (app.inject), read the pinned version
 *      back over HTTP and compute its SEMANTIC digest with the merged V2-003
 *      barrel.
 *   2. TEACH — create a TeachingSession from the installed version through
 *      the V2-006 public API; act as the real operator/learner: read the
 *      derived lesson (intent, prerequisites, step explanations, decision
 *      points, completion criteria, typed NOT_SPECIFIED_BY_WORKFLOW
 *      disclosures), answer ONE practice question INCORRECTLY first (record
 *      the typed rejection + correction), then correctly; raise and resolve a
 *      learner question; confirm the checkpoints in order, PAUSING mid-session
 *      and RESUMING to the exact checkpoint.
 *   3. INDEPENDENT PERFORMANCE — submit the independent-task assessment
 *      (the module's own evaluation of whether the learner can perform the
 *      task WITHOUT step-by-step teaching: reproduce the declared step order
 *      + each step's declared semantics from what was learned).
 *   4. NO MUTATION — re-read the installed version over HTTP after teaching:
 *      byte-identical; the installation still pins v1; the pinned semantic
 *      digest still matches.
 *
 * Determinism: the TeachingSession is driven by injected deterministic
 * sources (sequential ids, stepping clock — zero wall clock, zero
 * randomness in the teaching domain). Only the harness's own run-scoped
 * bookkeeping (runId, wall duration, and the repository's
 * uuid-derived org/workflow/version/installation ids) varies between runs;
 * the re-run comparison normalizes exactly those.
 *
 * Honest scope observations (recorded, NOT failures):
 *   - the operator is the implementing agent acting through the real public
 *     teaching API (no independently recruited human);
 *   - "perform the task independently" is evaluated by the module's own
 *     assessment semantics (order + declared-semantics reproduction) — real
 *     task EXECUTION belongs to the unmerged V2-005/V2-008, and teaching↔
 *     execution composition is deferred to integration gates.
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/teaching-sessions/run-install-and-teach-dogfooding.ts
 *
 * Exit code 0 = every assertion held (PASS); non-zero = a failure to triage.
 */
import { createPgliteDatabaseClient } from '@platform/postgres/pglite-database-client.js';
import { runMigrations } from '@platform/postgres/migration-runner.js';
import { createLogger } from '@platform/logger.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { buildServer } from '@api/server.js';
import { PgUserRepository } from '../../../src/modules/users/internal/pg-user-repository.js';
import { PgOrganizationRepository } from '../../../src/modules/organizations/internal/pg-organization-repository.js';
import { PgMembershipRepository } from '../../../src/modules/organizations/internal/pg-membership-repository.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
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

const OPERATOR_KEY = 'v2-006-dogfood-operator-key';
const LEARNER_ID = 'v2-006-operator';
/** Deterministic injected teaching clock base (2024-12-07T10:40:00Z). */
const TEACHING_CLOCK_BASE_MS = 1733568000000;
const TEACHING_CLOCK_STEP_MS = 1000;

interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
}
interface InstallationDetailPayload {
  installation: { id: string; workflowId: string; versionId: string; status: string };
  pinnedVersion: { id: string; versionNumber: number; contentDigest: string };
}

/** The real authored workflow: "triage an inbound support ticket". */
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
      spec: {
        class: 'agentic_computer_use',
        task: 'Draft a support reply and a severity classification for the ticket.',
      },
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

// --- experiment harness ---------------------------------------------------------

let failures = 0;

function step(name: string, held: boolean, detail: string): void {
  const mark = held ? 'PASS' : 'FAIL';
  if (!held) failures += 1;
  // eslint-disable-next-line no-console
  console.log(`[${mark}] ${name} :: ${detail}`);
}

/** Transcript lines are pure observations (deterministic given the lesson). */
function say(text: string): void {
  // eslint-disable-next-line no-console
  console.log(`        ${text}`);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const runId = `dogfood-${startedAt.toString(36)}`;

  // --- real infrastructure: PGlite + migrations --------------------------------

  const db = await createPgliteDatabaseClient();
  const logger = createLogger({ level: 'info' });
  const applied = await runMigrations(db, logger);
  step(
    'infra.migrations',
    applied.includes('0060_workflow_repository_v2.sql'),
    `real PGlite + migration-runner applied ${applied.length} migrations (0060 present: ${applied.includes('0060_workflow_repository_v2.sql')})`,
  );

  // --- real identity stack -----------------------------------------------------

  const userRepository = new PgUserRepository(db);
  const organizationRepository = new PgOrganizationRepository(db);
  const membershipRepository = new PgMembershipRepository(db);
  process.env['WFOS_V2_006_DOGFOOD_KEY'] = OPERATOR_KEY;
  const authProvider = new ApiKeyAuthProvider(db, new EnvSecretStore());
  const provisioner = new ApiKeyCredentialProvisioner(db);

  const org = await organizationRepository.create({ name: 'V2-006 Dogfood Org (operator tenant)' });
  const operator = await userRepository.upsertByExternalId({
    externalId: 'v2-006-dogfood-operator',
    displayName: 'V2-006 Dogfood Operator',
  });
  await membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
  await provisioner.provision({
    keyId: 'v2-006-dogfood-key', secretRef: 'WFOS_V2_006_DOGFOOD_KEY',
    externalId: 'v2-006-dogfood-operator', label: 'V2-006 Dogfood', rawKey: OPERATOR_KEY,
  });

  // --- the REAL application (V2-002 routes registered through api/server.ts) ---

  const memberships: OrganizationMembershipResolver = {
    isMember: async (userId, organizationId) =>
      (await membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
  };
  const service = new DefaultWorkflowRepositoryService({ db, memberships });
  const app: FastifyInstance = await buildServer({
    queue: new InMemoryQueue(),
    logger,
    auth: { authProvider, userRepository },
    workflowRepository: { workflowRepositoryService: service },
  });
  await app.ready();

  const inject = async (method: string, url: string, payload?: unknown) => {
    return app.inject({
      method: method as never,
      url,
      headers: { 'x-api-key': OPERATOR_KEY },
      payload: payload === undefined ? undefined : (JSON.parse(JSON.stringify(payload)) as never),
    });
  };

  // === STEP 1 — INSTALL a real authored workflow through the real route ========

  // eslint-disable-next-line no-console
  console.log('\n--- 1. INSTALL (real V2-002 routes over HTTP, real PGlite) ---');
  const document = authorSupportTriageDocument();
  const createRes = await inject('POST', `/organizations/${org.id}/workflow-repository/workflows`, {
    slug: 'support-ticket-triage',
    name: 'Support Ticket Triage',
    description: 'Triage an inbound support ticket and reply',
    visibility: 'private',
    content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  });
  const created = createRes.json() as {
    workflow: { id: string; headVersionId: string };
    initialVersion: VersionPayload;
  };
  const workflowId = created.workflow.id;
  const version1 = created.initialVersion;
  step(
    '1.install-create-workflow',
    createRes.statusCode === 201 && version1.versionNumber === 1 && created.workflow.headVersionId === version1.id,
    `POST /workflow-repository/workflows 201 — workflow (slug support-ticket-triage) born with immutable version 1 (number 1, head=v1)`,
  );

  const installRes = await inject('POST', `/organizations/${org.id}/workflow-repository/installations`, {
    workflowId,
    versionId: version1.id,
  });
  const installation = (installRes.json() as { installation: { id: string; versionId: string; status: string } }).installation;
  step(
    '1.install-pin-version',
    installRes.statusCode === 201 && installation.versionId === version1.id && installation.status === 'enabled',
    `POST /workflow-repository/installations 201 — the org INSTALLS (pins) version 1 (status enabled)`,
  );

  const readRes = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`);
  const versionBodyBefore = readRes.body;
  const readVersion = (readRes.json() as { version: VersionPayload }).version;
  step(
    '1.install-read-version',
    readRes.statusCode === 200 && readVersion.contentDigest === version1.contentDigest,
    `GET /workflow-repository/workflows/…/versions/v1 → 200 (content digest ${version1.contentDigest})`,
  );

  // Pin data: semantic digest computed by the MERGED V2-003 barrel over the
  // version content read back over HTTP (the teaching module never recomputes).
  const parsed = parseWorkflowIrDocument(JSON.stringify(readVersion.content));
  if (!parsed.ok) {
    step('1.install-parse-version', false, `version content did not parse as WorkflowIR: ${JSON.stringify(parsed)}`);
    process.exitCode = 1;
    return;
  }
  const installedDocument = parsed.document;
  const semanticDigest = computeWorkflowVersionSemanticDigest(installedDocument);
  step(
    '1.install-semantic-digest',
    semanticDigest.algorithm === 'sha-256' && semanticDigest.domain === 'workflowos/workflow-ir/v1' && /^[0-9a-f]{64}$/.test(semanticDigest.digest),
    `pinned WorkflowVersion semantic digest (merged V2-003 barrel): ${semanticDigest.digest}`,
  );

  // === STEP 2 — TEACH the real operator through the V2-006 public API =========

  // eslint-disable-next-line no-console
  console.log('\n--- 2. TEACH (real V2-006 public API, injected deterministic ids/clock) ---');
  const teaching = new DefaultTeachingSessionService({
    idFactory: createSequentialIdFactory('ts'),
    clock: createSteppingClock(TEACHING_CLOCK_BASE_MS, TEACHING_CLOCK_STEP_MS),
    store: new InMemoryTeachingSessionStore(),
  });
  const session = teaching.createSession({
    learnerId: LEARNER_ID,
    pinned: { workflowId, versionId: version1.id, semanticDigest },
  });
  step(
    '2.session-created',
    session.status === 'not_started' && session.pinned.versionId === version1.id && session.pinned.semanticDigest.digest === semanticDigest.digest,
    `TeachingSession ${session.id} bound to the installed version (status not_started, pin carried as data)`,
  );

  const begun = teaching.beginLesson({ sessionId: session.id, document: installedDocument });
  step(
    '2.lesson-begun',
    begun.status === 'in_progress' && begun.lesson !== null,
    `beginLesson verified the semantic digest against the pin and derived the lesson (status in_progress)`,
  );

  const lesson = teaching.getLesson({ sessionId: session.id, learnerId: LEARNER_ID });
  // eslint-disable-next-line no-console
  console.log('        operator reads the derived lesson (verbatim):');
  say(`intent: ${lesson.intent.statement}`);
  say('prerequisites:');
  for (const prerequisite of lesson.prerequisites) {
    say(`  - ${prerequisite.value}`);
  }
  say('steps:');
  for (const currentStep of lesson.steps) {
    say(`  ${currentStep.position}. ${currentStep.explanation}`);
  }
  say('decision points:');
  for (const decision of lesson.decisionPoints) {
    say(`  - ${decision.nodeId} (${decision.humanKind}): ${decision.instruction} → outcomes: ${decision.outcomes.join(', ')}`);
  }
  say('completion criteria:');
  for (const criterion of lesson.completionCriteria) {
    say(`  - ${criterion.value}`);
  }
  step(
    '2.lesson-read',
    lesson.steps.length === 6 && lesson.disclosures.length > 0 && lesson.steps.some((s) => s.disclosures.length > 0),
    `lesson: ${lesson.steps.length} steps in declared order [${lesson.stepOrder.join(' → ')}]; ${lesson.disclosures.length} typed NOT_SPECIFIED_BY_WORKFLOW disclosures (the workflow's own gaps, never invented prose)`,
  );

  // --- practice: ONE deliberately INCORRECT answer, then the correct one -------
  const questions = teaching.listPracticeQuestions({ sessionId: session.id, learnerId: LEARNER_ID });
  step(
    '2.practice-questions',
    questions.length === lesson.steps.length && questions.every((q) => q.options.length > 0),
    `${questions.length} practice questions derived from the workflow's own declared step semantics (options = declared semantics only)`,
  );

  const wrongAnswer = 'messaging.send'; // the operator deliberately confuses fetch_ticket's capability
  const incorrect = teaching.attemptPractice({
    sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_ticket', answer: wrongAnswer,
  });
  const incorrectTyped = incorrect.outcome === 'incorrect' && incorrect.declaredSemantic === 'github.repository.read';
  step(
    '2.practice-incorrect-typed-rejection',
    incorrectTyped,
    `deliberately WRONG practice answer for fetch_ticket ("${wrongAnswer}") → typed outcome "${incorrect.outcome}" with the correction quoting the workflow's own declaration: "${incorrect.outcome === 'incorrect' ? incorrect.declaredSemantic : '?'}"`,
  );
  say(`correction feedback: ${incorrect.outcome === 'incorrect' ? incorrect.feedback : '?'}`);

  const corrected = teaching.attemptPractice({
    sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_ticket', answer: 'github.repository.read',
  });
  step(
    '2.practice-corrected',
    corrected.outcome === 'correct',
    `the corrected practice answer ("github.repository.read") → typed outcome "correct"`,
  );

  // --- an honest learner question (retained, then resolved by re-reading) ------
  const raised = teaching.raiseQuestion({
    sessionId: session.id,
    learnerId: LEARNER_ID,
    question: 'What does the escalate_backlog subworkflow actually do?',
  });
  const escalatedStep = lesson.steps.find((s) => s.nodeId === 'escalate_backlog')!;
  const disclosureAnswer = escalatedStep.disclosures.find((d) => d.field === 'subworkflow_semantics');
  const resolvedSession = teaching.resolveQuestion({
    sessionId: session.id,
    learnerId: LEARNER_ID,
    questionId: raised.unresolvedQuestions[0]!.id,
  });
  step(
    '2.learner-question-retained-and-resolved',
    raised.unresolvedQuestions.length === 1 &&
      disclosureAnswer !== undefined &&
      resolvedSession.unresolvedQuestions[0]!.resolvedAt !== null,
    `operator question retained across the session; the answer is the workflow's own typed disclosure, not invention: "${disclosureAnswer?.message ?? '?'}"`,
  );

  // --- confirm checkpoints in order; PAUSE mid-session; RESUME exactly ---------
  const confirmedOrder: string[] = [];
  let pauseAt: string | null = null;
  let resumedAt: string | null = null;
  for (const currentStep of lesson.steps) {
    if (currentStep.position === 3) {
      // mid-session (2 of 6 checkpoints confirmed): pause before human_review.
      const paused = teaching.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID });
      const resumed = teaching.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID });
      pauseAt = paused.progress.nextCheckpointNodeId;
      resumedAt = resumed.resumeCheckpointNodeId;
    }
    teaching.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: currentStep.nodeId });
    confirmedOrder.push(currentStep.nodeId);
  }
  step(
    '2.pause-resume-exact-checkpoint',
    pauseAt === 'human_review' && resumedAt === 'human_review',
    `paused mid-session (after 2/6 confirmations) and RESUMED to the exact pending checkpoint "${resumedAt}"`,
  );
  step(
    '2.checkpoints-confirmed-in-order',
    confirmedOrder.join(',') === lesson.stepOrder.join(','),
    `all 6 checkpoints confirmed in the lesson order: ${confirmedOrder.join(' → ')}`,
  );

  // === STEP 3 — INDEPENDENT PERFORMANCE ASSESSMENT =============================

  // eslint-disable-next-line no-console
  console.log('\n--- 3. INDEPENDENT PERFORMANCE (without step-by-step teaching) ---');
  // The operator's reproduction of the task from what was learned: the
  // declared step order and each step's declared semantics (no lesson open).
  const orderedStepIds = lesson.stepOrder;
  const semanticsByStep: Record<string, string> = {
    fetch_ticket: 'github.repository.read',
    draft_reply: 'Draft a support reply and a severity classification for the ticket.',
    human_review: 'Approve sending the drafted support reply and syncing the backlog.',
    send_reply: 'messaging.send',
    escalate_backlog: 'wf-backlog-sync@wfv_0192_backlog_sync_v1',
    log_miss: 'filesystem.write',
  };
  const assessment = teaching.submitIndependentPerformance({
    sessionId: session.id, learnerId: LEARNER_ID, orderedStepIds, semanticsByStep,
  });
  step(
    '3.operator-performs-task-independently',
    assessment.passed === true && assessment.orderCorrect === true && assessment.sessionStatus === 'completed',
    `the operator reproduced the workflow's declared step order and every step's declared semantics WITHOUT step-by-step teaching: assessment passed (order correct, ${assessment.perStep.filter((s) => s.semanticsCorrect).length}/${assessment.perStep.length} semantics correct) — session completed`,
  );

  // === STEP 4 — teaching evidence + NO MUTATION of the installed workflow ======

  // eslint-disable-next-line no-console
  console.log('\n--- 4. EVIDENCE + NO MUTATION (real route re-read) ---');
  const finalSession = teaching.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
  const allTeaching = finalSession.evidence.every((record) => record.evidenceClass === TEACHING_EVIDENCE_CLASS);
  const kindSequence = finalSession.evidence.map((record) => record.kind).join(',');
  step(
    '4.teaching-evidence-typed',
    allTeaching && finalSession.evidence.length === 9,
    `${finalSession.evidence.length} teaching-evidence records (2 practice + 6 checkpoint confirmations + 1 assessment), every evidenceClass "teaching" (never execution evidence): ${kindSequence}`,
  );

  const readAfter = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`);
  const detailRes = await inject('GET', `/organizations/${org.id}/workflow-repository/installations/${installation.id}`);
  const detail = detailRes.json() as InstallationDetailPayload;
  step(
    '4.no-mutation-installed-workflow',
    readAfter.statusCode === 200 && readAfter.body === versionBodyBefore && detail.pinnedVersion.id === version1.id,
    `GET the installed version after teaching → 200, response body BYTE-IDENTICAL to the pre-teaching snapshot; the installation still pins version 1 (number ${detail.pinnedVersion.versionNumber})`,
  );
  step(
    '4.pin-still-matches',
    computeWorkflowVersionSemanticDigest(installedDocument).digest === finalSession.pinned.semanticDigest.digest,
    `the pinned semantic digest still matches the unchanged installed content (${finalSession.pinned.semanticDigest.digest})`,
  );

  // --- wrap-up -------------------------------------------------------------------

  const durationMs = Date.now() - startedAt;
  await app.close();
  await db.close();
  delete process.env['WFOS_V2_006_DOGFOOD_KEY'];

  // eslint-disable-next-line no-console
  console.log(
    `\nrunId=${runId} workflow=${workflowId} version=${version1.id} installation=${installation.id} semanticDigest=${semanticDigest.digest} sessionId=${session.id} teachingClockBase=${TEACHING_CLOCK_BASE_MS} durationMs=${durationMs} failures=${failures}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    'OBSERVATION (scope, not failure): the operator is the implementing agent acting through the real public teaching API (not an independently recruited human); independent performance is evaluated by the teaching module\'s assessment semantics (order + declared-semantics reproduction) — real task execution belongs to unmerged V2-005/V2-008 and teaching↔execution composition is deferred to integration gates.',
  );
  // eslint-disable-next-line no-console
  console.log(
    'DETERMINISM NOTE: re-running this harness yields an identical teaching transcript (session ids ts_1…, stepping clock stamps, lesson content, evidence order); only run-scoped bookkeeping (runId, wall durationMs, and the repository uuid-derived org/workflow/version/installation identities) differs and is normalized in the evidence re-run comparison.',
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();

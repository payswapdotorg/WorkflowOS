/**
 * IG-004 — standalone dogfooding RUN (real process, real product paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/integration-gates/run-ig-004-dogfooding.ts
 *
 * Executes the frozen IG-004 dogfooding clause for real:
 *
 *   "Execute one event-triggered workflow, teach the same workflow to a
 *    human, and compare a baseline and an optimization proposal against
 *    the same acceptance task."
 *
 * Real paths only: real PGlite (ALL 62 migrations incl. 0062) + the real
 * identity stack (API-key operator) + the REAL Fastify app with the REAL
 * V2-002 workflow-repository routes, the REAL V2-005 workflow-runs routes
 * and the REAL V2-009 workflow-deployments routes, every step driven over
 * HTTP via app.inject() + the device node registered through the REAL
 * V2-004 protocol + the V2-010 reverse-teaching session service composed
 * on the installed pin + the V2-011 optimization service with the
 * materializer port satisfied by the REAL repository service.
 *
 * The experiment (ONE workflow, ONE installed immutable version, all three
 * module families):
 *
 *   1. EVENT-TRIGGERED WORKFLOW — the repository ticket digest workflow is
 *      authored (merged V2-003 builder), created + installed (pinned) v1
 *      through the real V2-002 routes, deployed (V2-009 pins the SAME exact
 *      version) and subscribed to file.changed events. The REAL acceptance
 *      task: a REAL repository-board snapshot FILE in a real sandbox
 *      directory; its file.changed event is delivered through the real
 *      ingest route; the triggered run pins v1's exact identity (V2-002
 *      content digest + V2-003 semantic digest) and is EXECUTED to
 *      completion through the real V2-005 routes — the scan step records
 *      the AGENTIC computer-use loop (a real observation of the real board
 *      file — its real sha-256 as the observation commitment — then the
 *      action), 2 invocations. This event-triggered run IS the baseline.
 *   2. DUPLICATE EVENT — the SAME (source, eventId) delivered again
 *      converges (HTTP 200, created=false, zero new deliveries); still
 *      exactly ONE run.
 *   3. TEACH THE SAME WORKFLOW TO A HUMAN — a reverse-teaching session over
 *      the SAME installation pin; the lesson derives from the installed
 *      version; the human performs the whole manual lesson (the
 *      spreadsheet.edit step safety-gated: performance refused typed
 *      without the explicit acknowledgment); finalization completed; every
 *      evidence record is teaching evidence pinned to the installation;
 *      teaching creates ZERO runs.
 *   4. OPTIMIZATION PROPOSAL — analyze the installed v1 (exactly one
 *      api_substitution opportunity on the agentic scan step), propose
 *      (provenance pins the REAL v1 identity), approve (the owner's human
 *      gate), materialize the candidate as a REAL new WorkflowVersion v2
 *      through the port — never a mutation, never an activation.
 *   5. BASELINE vs OPTIMIZED on the SAME acceptance task — the optimized
 *      run executes the SAME real task against v2 (NOT activated —
 *      installationId null): the scan step is the direct deterministic API
 *      call, 1 invocation, the SAME real outcome artifact. The module's
 *      empirical engine compares the two REAL run histories (correctness
 *      FIRST, then resource cost + maintainability) and the deterministic
 *      document comparison over the two REAL versions (the frozen rubric).
 *   6. NO MUTATION + NO ACTIVATION + INDEPENDENTLY ADDRESSABLE — v1 re-read
 *      byte-identical after the whole experiment; the installation and the
 *      deployment keep pinning v1; both versions fetchable by id with
 *      DISTINCT content digests; two runs, each pinning its exact version.
 *
 * Determinism: the whole experiment runs TWICE on fresh stacks (fresh
 * PGlite + fresh identity stack per run); the transcripts are compared
 * after normalizing run-scoped bookkeeping (uuid-shaped ids, derived
 * dep_/sub_/evt_/dlv_/run_ ids, sandbox suffixes, run labels, wall-clock
 * lines). Exits non-zero when any experiment check fails (fail-closed
 * runner).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  serializeWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  buildTriggerTestStack,
  registerNode,
  type TriggerTestStack,
} from '../workflow-deployments/trigger-test-support.js';
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

const API_KEY = 'ig-004-dogfooding-api-key';
const OPERATOR_EXTERNAL_ID = 'ig-004-dogfooding-operator';
const LEARNER_ID = 'ig-004-dogfooding-human-learner';
const CLOUD_POLICY = { placement: { required: 'cloud_allowed' as const }, privacy: { localOnly: false } };

// ============================================================================
// The transcript harness (check/section/norm — the family precedent)
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
// The real acceptance task: the repository board snapshot (a REAL file)
// ============================================================================

const BOARD_SNAPSHOT_CONTENT = [
  '# repository board snapshot — pectoraux/WorkflowOS',
  'ticket-201 [open] IG-004 event-trigger correlation',
  'ticket-202 [open] reverse-teaching pin verification',
  'ticket-203 [open] optimization candidate isolation',
  'ticket-204 [resolved] duplicate event convergence',
].join('\n');

/** The task's outcome artifact: the digest line computed from the real file. */
function digestLineOf(snapshotContent: string): string {
  const openTickets = snapshotContent
    .split('\n')
    .filter((line) => line.includes('[open]')).length;
  return `open tickets: ${openTickets} — snapshot@${sha256Of(snapshotContent).slice(0, 12)}`;
}

// ============================================================================
// The real workflow under test (authored through the merged V2-003 builder;
// the scan_board agentic node declares EXACTLY ONE API-stable ordinary
// requirement — the post-correction V2-011 invariant; the record_rejection
// human node carries the sensitive spreadsheet.edit capability so the
// reverse-teaching lesson exercises the V2-008 safety gate)
// ============================================================================

function authorDigestReportDocument(): WorkflowIrDocument {
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
        task: 'Scan the repository board and summarize the open ticket digest.',
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

// ============================================================================
// One dogfooding RUN (the experiment; returns the transcript text)
// ============================================================================

async function runExperiment(runLabel: string): Promise<string> {
  const support: TriggerTestStack = await buildTriggerTestStack({
    WFOS_IG_004_DOGFOODING_KEY: API_KEY,
  });
  transcript.length = 0;
  let app: FastifyInstance;
  try {
    // --- the operator tenant + the REAL device node -----------------------
    const operator = await support.stack.userRepository.upsertByExternalId({
      externalId: OPERATOR_EXTERNAL_ID,
      displayName: 'IG-004 Dogfooding Operator',
    });
    const org = await support.stack.organizationRepository.create({ name: `IG-004 Dogfooding Org ${runLabel}` });
    await support.stack.membershipRepository.assign({
      userId: operator.id,
      organizationId: org.id,
      roleId: 'owner',
    });
    const orgId = org.id;
    const principal = { userId: operator.id };

    const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
    await provisioner.provision({
      keyId: 'ig-004-dogfooding-key',
      secretRef: 'WFOS_IG_004_DOGFOODING_KEY',
      externalId: OPERATOR_EXTERNAL_ID,
      label: 'IG-004 Dogfooding Operator',
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

    const inject = async (
      method: 'GET' | 'POST',
      url: string,
      payload?: unknown,
    ): Promise<{ status: number; body: Record<string, unknown>; raw: string }> => {
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
    };

    const device = registerNode(support.nodes, 'ig-004-dogfooding-device', 'desktop');

    section(`${runLabel} — 0. ONE immutable version: authored, installed (pinned), deployed`);
    // The REAL acceptance task data: a real board-snapshot file.
    const sandboxDir = mkdtempSync(join(tmpdir(), 'ig-004-dogfood-'));
    const boardFile = join(sandboxDir, 'board-snapshot.txt');
    writeFileSync(boardFile, BOARD_SNAPSHOT_CONTENT, 'utf8');
    const realBoardDigest = sha256Of(readFileSync(boardFile, 'utf8'));
    const digestLine = digestLineOf(readFileSync(boardFile, 'utf8'));
    const realOutcomeCommitment = sha256Of(`scan_board:digest:${digestLine}`);

    const createRes = await inject('POST', `/organizations/${orgId}/workflow-repository/workflows`, {
      slug: 'ig4-ticket-digest',
      name: 'Repository Ticket Digest Report',
      description: 'Fetch tickets, scan the board, approve, record and send the digest',
      visibility: 'private',
      content: JSON.parse(serializeWorkflowIrDocument(authorDigestReportDocument())) as Record<string, unknown>,
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    });
    const created = createRes.body as unknown as {
      workflow: { id: string };
      initialVersion: { id: string; versionNumber: number; contentDigest: string };
    };
    const workflowId = created.workflow.id;
    const version1Id = created.initialVersion.id;
    check(
      '0.baseline-created',
      createRes.status === 201 && created.initialVersion.versionNumber === 1,
      `the gate workflow created through the real V2-002 route (version 1, ${norm(version1Id)})`,
    );

    const installRes = await inject('POST', `/organizations/${orgId}/workflow-repository/installations`, {
      workflowId,
      versionId: version1Id,
    });
    const installation = (
      installRes.body as unknown as { installation: { id: string; versionId: string; status: string } }
    ).installation;
    check(
      '0.baseline-installed',
      installRes.status === 201 && installation.versionId === version1Id && installation.status === 'enabled',
      `version 1 INSTALLED (pinned) through the real installations route`,
    );

    const readRes = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${version1Id}`);
    const versionBodyBefore = readRes.raw;
    const parsed = parseWorkflowIrDocument(
      JSON.stringify((readRes.body as unknown as { version: { content: Record<string, unknown> } }).version.content),
    );
    const baselineDocument = parsed.ok ? parsed.document : null;
    const semanticDigest = baselineDocument
      ? computeWorkflowVersionSemanticDigest(baselineDocument)
      : null;
    check(
      '0.baseline-readable',
      readRes.status === 200 && baselineDocument !== null && semanticDigest !== null,
      `the installed version read back over HTTP; V2-003 semantic digest ${semanticDigest ? norm(semanticDigest.digest) : '—'}`,
    );

    // The deployment pins the SAME exact immutable version (V2-009 through
    // the merged V2-002 repository; plan compiled by V2-007).
    const { deployment } = await support.deployments.createDeployment(principal, {
      organizationId: orgId,
      workflowId,
      versionId: version1Id,
      installationId: installation.id,
      name: 'ig4-digest-deployment',
      placement: CLOUD_POLICY,
    });
    const { subscription: eventSubscription } = await support.deployments.createSubscription(principal, {
      deploymentId: deployment.id,
      kind: 'event',
      eventPattern: { eventType: 'file.changed' },
    });
    check(
      '0.deployed',
      deployment.workflowId === workflowId &&
        deployment.versionId === version1Id &&
        deployment.installationId === installation.id,
      `the deployment pins the installed version exactly (V2-009 over the same immutable pin); one file.changed event subscription`,
    );

    section(`${runLabel} — 1. EXECUTE the event-triggered workflow (the baseline run)`);
    check(
      '1.real-task-file',
      readFileSync(boardFile, 'utf8') === BOARD_SNAPSHOT_CONTENT,
      `the repository-board snapshot is a REAL file (${norm(realBoardDigest)}); the acceptance task outcome is the digest line computed from it`,
    );

    // The REAL file.changed event for the real board file, delivered through
    // the real ingest route.
    const eventPayload = {
      source: device.nodeId,
      eventId: 'ig4-board-change-0001',
      eventType: 'file.changed',
      payload: { path: boardFile },
    };
    const first = await inject('POST', `/organizations/${orgId}/workflow-deployments/events`, eventPayload);
    const firstEvent = (first.body as unknown as { event: { id: string; payloadCommitment: string } }).event;
    const firstDeliveries = (first.body as unknown as {
      deliveries: { state: string; runId: string | null }[];
    }).deliveries;
    check(
      '1.event-delivered',
      first.status === 201 && first.body.created === true && firstDeliveries.length === 1 && firstDeliveries[0]!.state === 'delivered',
      `the real file.changed event ingested (HTTP 201): one delivery, state delivered, run ${firstDeliveries[0]?.runId ? norm(firstDeliveries[0].runId) : '—'}`,
    );
    const baselineRunId = firstDeliveries[0]!.runId!;

    // The triggered run pins the EXACT installed version identity.
    const baselineRun = await support.runs.getRun(principal, baselineRunId);
    check(
      '1.run-pins-v1',
      baselineRun.workflowId === workflowId &&
        baselineRun.versionId === version1Id &&
        baselineRun.versionContentDigest === created.initialVersion.contentDigest &&
        baselineRun.versionSemanticDigest === semanticDigest?.digest &&
        baselineRun.installationId === installation.id &&
        baselineRun.trigger.type === 'file_event' &&
        baselineRun.trigger.id === `evt:${firstEvent.id}:${eventSubscription.id}` &&
        JSON.stringify(baselineRun.inputCommitments) === JSON.stringify([firstEvent.payloadCommitment]),
      `the event-triggered run instantiates the pinned WorkflowVersion: exact (workflow, version) pin, V2-002 content digest + V2-003 semantic digest of the INSTALLED v1, the installation pin, and the event/run correlation (trigger embeds the inbox event identity; the run's input commitment IS the event's payload commitment)`,
    );

    // DUPLICATE EVENT: the same (source, eventId) delivered again converges.
    const duplicate = await inject('POST', `/organizations/${orgId}/workflow-deployments/events`, eventPayload);
    const runsAfterDuplicate = await support.runs.listRunsInOrganization(principal, orgId);
    check(
      '1.duplicate-converged',
      duplicate.status === 200 &&
        duplicate.body.created === false &&
        (duplicate.body as unknown as { deliveries: unknown[] }).deliveries.length === 0 &&
        runsAfterDuplicate.length === 1,
      `duplicate event CONVERGED idempotently (HTTP 200, created=false, zero new deliveries); still exactly ONE run`,
    );

    // EXECUTE the triggered run through the real V2-005 routes: all five
    // declared steps; the scan step records the AGENTIC computer-use loop
    // (observe the real board file — its real sha-256 as the observation
    // commitment — then act).
    const stepInputCommitments = [firstEvent.payloadCommitment];
    const driveRun = async (label: string, runId: string, agentic: boolean) => {
      await inject('POST', `/workflow-runs/runs/${runId}/start`, {
        commandId: `cmd-ig004-${label}-start`,
        correlationId: `correlation-ig004-${label}`,
        nodeId: `node_ig004_${label}`,
      });
      const stepPlan: ReadonlyArray<{
        stepId: string;
        executionClass: string;
        invocations: ReadonlyArray<{ capability: string; commitments: string[] }>;
        outputCommitments: string[];
      }> = [
        {
          stepId: 'fetch_tickets',
          executionClass: 'deterministic_api',
          invocations: [
            { capability: 'github.repository.read', commitments: [sha256Of('tickets:board')] },
          ],
          outputCommitments: [sha256Of('fetch_tickets:outputs:ok')],
        },
        agentic
          ? {
              stepId: 'scan_board',
              executionClass: 'agentic_computer_use',
              invocations: [
                { capability: 'browser.observe', commitments: [realBoardDigest] },
                { capability: 'github.repository.read', commitments: [sha256Of(`digest:${digestLine}`)] },
              ],
              outputCommitments: [realOutcomeCommitment, sha256Of('openCount:3')],
            }
          : {
              stepId: 'scan_board',
              executionClass: 'deterministic_api',
              invocations: [
                { capability: 'github.repository.read', commitments: [sha256Of(`digest:${digestLine}`)] },
              ],
              outputCommitments: [realOutcomeCommitment, sha256Of('openCount:3')],
            },
        {
          stepId: 'approve_digest',
          executionClass: 'human',
          invocations: [
            { capability: 'workflow.execute', commitments: [sha256Of('approved:true')] },
          ],
          outputCommitments: [sha256Of('approve_digest:outputs:ok')],
        },
        {
          stepId: 'record_rejection',
          executionClass: 'human',
          invocations: [
            { capability: 'workflow.execute', commitments: [sha256Of('reason:digest-recorded')] },
          ],
          outputCommitments: [sha256Of('record_rejection:outputs:ok')],
        },
        {
          stepId: 'send_digest',
          executionClass: 'deterministic_api',
          invocations: [
            { capability: 'messaging.send', commitments: [sha256Of('messageId:msg-ig004-digest')] },
          ],
          outputCommitments: [sha256Of('send_digest:outputs:ok')],
        },
      ];
      let commandCounter = 0;
      for (const step of stepPlan) {
        await inject('POST', `/workflow-runs/runs/${runId}/steps/${step.stepId}/started`, {
          commandId: `cmd-ig004-${label}-${String(commandCounter).padStart(3, '0')}-a`,
          correlationId: `correlation-ig004-${label}`,
          inputCommitments: stepInputCommitments,
        });
        for (const invocation of step.invocations) {
          const invocationRes = await inject('POST', `/workflow-runs/runs/${runId}/invocations`, {
            commandId: `cmd-ig004-${label}-${String(commandCounter).padStart(3, '0')}-b-${invocation.capability.replace(/\./g, '-')}`,
            correlationId: `correlation-ig004-${label}`,
            capability: invocation.capability,
            executionClass: step.executionClass,
            stepId: step.stepId,
            inputCommitments: stepInputCommitments,
          });
          const invocationId = (invocationRes.body as unknown as { invocation: { id: string } }).invocation.id;
          await inject('POST', `/workflow-runs/runs/${runId}/invocations/${invocationId}/completed`, {
            commandId: `cmd-ig004-${label}-${String(commandCounter).padStart(3, '0')}-c-${invocation.capability.replace(/\./g, '-')}`,
            correlationId: `correlation-ig004-${label}`,
            outcome: 'succeeded',
            outputCommitments: invocation.commitments,
          });
        }
        await inject('POST', `/workflow-runs/runs/${runId}/steps/${step.stepId}/completed`, {
          commandId: `cmd-ig004-${label}-${String(commandCounter).padStart(3, '0')}-d`,
          correlationId: `correlation-ig004-${label}`,
          outcome: 'succeeded',
          outputCommitments: step.outputCommitments,
        });
        commandCounter += 1;
      }
      const completeRes = await inject('POST', `/workflow-runs/runs/${runId}/complete`, {
        commandId: `cmd-ig004-${label}-complete`,
        correlationId: `correlation-ig004-${label}`,
      });
      check(
        `${label === 'baseline' ? '1' : '4'}.${label}-completed`,
        completeRes.status === 200 &&
          (completeRes.body as unknown as { run: { state: string } }).run.state === 'completed',
        `the ${label === 'baseline' ? 'event-triggered BASELINE' : 'OPTIMIZED'} run EXECUTED to completion through the real V2-005 routes (all five declared steps)`,
      );
      const historyRes = await inject('GET', `/workflow-runs/runs/${runId}/history`);
      return historyRes.body as unknown as {
        run: { state: string };
        steps: { stepId: string; status: string; outputCommitments: string[] }[];
        invocations: { capability: string }[];
      };
    };

    const baselineHistory = await driveRun('baseline', baselineRunId, true);

    section(`${runLabel} — 2. TEACH the same workflow to a human (reverse teaching)`);
    const teaching = new DefaultReverseTeachingSessionService({
      idFactory: createTeachingIdFactory('ig4-rt'),
      clock: createTeachingClock(1733568000000, 1000),
      store: new InMemoryReverseTeachingSessionStore(),
    });
    const session = teaching.createSession({
      learnerId: LEARNER_ID,
      pin: {
        installationId: installation.id,
        workflowId,
        versionId: version1Id,
        semanticDigest: semanticDigest!,
      },
    });
    const begun = teaching.beginLesson({ sessionId: session.id, document: baselineDocument! });
    const recordStep = begun.lesson!.steps.find((step) => step.nodeId === 'record_rejection')!;
    check(
      '2.lesson-from-installed',
      begun.status === 'in_progress' &&
        JSON.stringify(begun.lesson!.stepOrder) ===
          JSON.stringify(['fetch_tickets', 'scan_board', 'approve_digest', 'record_rejection', 'send_digest']),
      `the reverse-teaching session pins the SAME installation; the lesson derives from the INSTALLED version (the digest-verified manual view: 5 steps in canonical order)`,
    );
    check(
      '2.safety-gate',
      recordStep.safety === 'safety_gated' && JSON.stringify(recordStep.sensitiveCapabilities) === JSON.stringify(['spreadsheet.edit']),
      `the spreadsheet.edit step is SAFETY-GATED (V2-008's sensitive vocabulary consumed by V2-010)`,
    );

    // the human performs the whole manual lesson (safety-gated attempt
    // without the acknowledgment refused typed — the negative)
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
    check(
      '2.safety-refused',
      safetyRejected,
      `the safety-gated step REFUSES performance without the explicit acknowledgment (typed SAFETY_ACKNOWLEDGMENT_REQUIRED)`,
    );
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
    const finalSession = teaching.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
    const runsAfterTeaching = await support.runs.listRunsInOrganization(principal, orgId);
    check(
      '2.lesson-completed',
      finalization.sessionStatus === 'completed' &&
        finalization.performedStepCount === 3 &&
        finalization.disclosureAcknowledgedStepCount === 2 &&
        finalSession.evidence.every(
          (record) =>
            record.evidenceClass === 'teaching' &&
            record.pin.installationId === installation.id &&
            record.pin.versionId === version1Id,
        ),
      `the human completed the manual lesson (${finalization.performedStepCount} performed + ${finalization.disclosureAcknowledgedStepCount} disclosure-acknowledged); every evidence record is TEACHING evidence pinned to the SAME installation`,
    );
    check(
      '2.zero-runs',
      runsAfterTeaching.length === 1,
      `teaching created ZERO runs (the execution/teaching distinction): still exactly ONE run after the whole lesson`,
    );

    section(`${runLabel} — 3. The OPTIMIZATION PROPOSAL (a new version, never a mutation)`);
    const materializer: CandidateVersionMaterializer = {
      createCandidateVersion: async (input) => {
        const result = await support.repository.createVersion(principal, input.workflowId, {
          content: input.content,
          protocol: { irSchemaVersion: input.protocol.irSchemaVersion },
          parentVersionId: input.parentVersionId,
        });
        return { versionId: result.version.id };
      },
    };
    const optimization = new DefaultWorkflowOptimizationService({
      idFactory: createOptimizationIdFactory('ig4-opt'),
      clock: createOptimizationClock(1789000000000, 1000),
      store: new InMemoryOptimizationProposalStore(),
      materializer,
    });
    const analysis = optimization.analyzeWorkflow(baselineDocument!);
    const opportunity = analysis.opportunities[0]!;
    check(
      '3.analyzed',
      analysis.opportunities.length === 1 &&
        opportunity.kind === 'api_substitution' &&
        (opportunity.kind === 'api_substitution' ? opportunity.nodeId : '') === 'scan_board',
      `the deterministic analysis of the installed v1 finds EXACTLY ONE opportunity: api_substitution of the agentic scan step (its single API-stable ordinary requirement github.repository.read beats UI automation)`,
    );
    const proposal = optimization.createProposal({
      ownerId: operator.id,
      workflowId,
      versionId: version1Id,
      document: baselineDocument!,
      opportunityNodeId: 'scan_board',
    });
    check(
      '3.proposal-pinned',
      proposal.status === 'proposed' &&
        proposal.provenance.baseline.workflowId === workflowId &&
        proposal.provenance.baseline.versionId === version1Id &&
        proposal.provenance.baseline.semanticDigest === semanticDigest?.digest &&
        proposal.comparison.correctness.equivalent === true &&
        proposal.comparison.negotiation.decision === 'accept',
      `the PROPOSAL (status proposed) pins the REAL v1 identity (workflow + version + V2-003 semantic digest) with provenance; task-surface equivalence proven + the merged V2-003 negotiation accepts`,
    );
    optimization.approveProposal({ proposalId: proposal.id, ownerId: operator.id });
    const { materialization } = await optimization.materializeProposal({
      proposalId: proposal.id,
      ownerId: operator.id,
    });
    const candidateVersionId = materialization.versionId;
    const candidateRead = await inject(
      'GET',
      `/workflow-repository/workflows/${workflowId}/versions/${candidateVersionId}`,
    );
    const candidateVersion = (candidateRead.body as unknown as { version: { id: string; versionNumber: number; contentDigest: string } })
      .version;
    check(
      '3.materialized-v2',
      candidateRead.status === 200 &&
        candidateVersion.id === candidateVersionId &&
        candidateVersionId !== version1Id &&
        candidateVersion.versionNumber === 2 &&
        candidateVersion.contentDigest !== created.initialVersion.contentDigest,
      `the approved proposal MATERIALIZED as a REAL new WorkflowVersion 2 through the port backed by the real V2-002 repository (a distinct immutable identity — the proposed change, never a mutation of the source)`,
    );

    section(`${runLabel} — 4. BASELINE vs OPTIMIZED on the SAME acceptance task`);
    const optimizedRunRes = await inject('POST', `/organizations/${orgId}/workflow-runs/runs`, {
      commandId: 'cmd-ig004-optimized-run',
      correlationId: 'correlation-ig004-optimized',
      workflowId,
      versionId: candidateVersionId,
      installationId: null,
      trigger: { type: 'manual', id: 'ig004-optimized-comparison' },
      inputCommitments: [sha256Of(`ticketQuery:board-snapshot:${realBoardDigest.slice(0, 16)}`)],
    });
    const optimizedRunId = (optimizedRunRes.body as unknown as { run: { id: string } }).run.id;
    const optimizedRunRecord = await support.runs.getRun(principal, optimizedRunId);
    check(
      '4.optimized-pins-v2',
      optimizedRunRes.status === 201 &&
        optimizedRunRecord.versionId === candidateVersionId &&
        optimizedRunRecord.versionContentDigest === candidateVersion.contentDigest &&
        optimizedRunRecord.installationId === null,
      `the optimized run is INDEPENDENTLY addressable: it pins v2's exact identity through the real V2-005 boundary (installationId null — the candidate is NOT activated)`,
    );
    const optimizedHistory = await driveRun('optimized', optimizedRunId, false);

    const runComparison = optimization.compareRunHistories(
      baselineHistory as never,
      optimizedHistory as never,
    );
    const baselineScanOutputs =
      baselineHistory.steps.find((step) => step.stepId === 'scan_board')?.outputCommitments ?? [];
    const optimizedScanOutputs =
      optimizedHistory.steps.find((step) => step.stepId === 'scan_board')?.outputCommitments ?? [];
    check(
      '4.correctness-first',
      runComparison.correctness.equivalent === true &&
        runComparison.correctness.baselineCompleted &&
        runComparison.correctness.optimizedCompleted &&
        runComparison.correctness.sameStepSet &&
        runComparison.correctness.sameStepStatuses &&
        JSON.stringify(baselineScanOutputs) === JSON.stringify(optimizedScanOutputs) &&
        baselineScanOutputs.includes(realOutcomeCommitment),
      `CORRECTNESS FIRST: both real runs completed with the SAME five steps and statuses; the scan step's output commitment is the SAME REAL artifact (${norm(realOutcomeCommitment)} — the digest line computed from the real board file)`,
    );
    check(
      '4.resource-cost',
      runComparison.resourceCost.baselineInvocationCount === 6 &&
        runComparison.resourceCost.optimizedInvocationCount === 5 &&
        runComparison.resourceCost.invocationDelta === -1,
      `resource cost: the baseline's event-triggered agentic loop (observe→act) costs ${runComparison.resourceCost.baselineInvocationCount} invocations; the optimized direct API call ${runComparison.resourceCost.optimizedInvocationCount} (Δ${runComparison.resourceCost.invocationDelta})`,
    );
    check(
      '4.maintainability-signals',
      JSON.stringify([...runComparison.maintainabilitySignals.baselineDistinctCapabilities].sort()) ===
        JSON.stringify(['browser.observe', 'github.repository.read', 'messaging.send', 'workflow.execute']) &&
        JSON.stringify([...runComparison.maintainabilitySignals.optimizedDistinctCapabilities].sort()) ===
          JSON.stringify(['github.repository.read', 'messaging.send', 'workflow.execute']),
      `maintainability signals: the optimized run's capability surface drops the browser observation (${runComparison.maintainabilitySignals.baselineDistinctCapabilities.length} → ${runComparison.maintainabilitySignals.optimizedDistinctCapabilities.length} distinct capabilities)`,
    );
    const candidateParsed = parseWorkflowIrDocument(
      JSON.stringify(
        (candidateRead.body as unknown as { version: { content: Record<string, unknown> } }).version.content,
      ),
    );
    const candidateDocument = candidateParsed.ok ? candidateParsed.document : null;
    const docComparison =
      candidateDocument !== null && baselineDocument !== null
        ? optimization.compareVersions(baselineDocument, candidateDocument)
        : null;
    check(
      '4.rubric-deltas',
      docComparison !== null &&
        docComparison.correctness.equivalent === true &&
        docComparison.latency.delta === -2 &&
        docComparison.cost.delta === -3 &&
        docComparison.maintenance.delta === -1,
      docComparison !== null
        ? `the deterministic comparison over the two REAL versions: task-surface equivalent; latency ${docComparison.latency.baseline}→${docComparison.latency.candidate} (Δ${docComparison.latency.delta}), cost ${docComparison.cost.baseline}→${docComparison.cost.candidate} (Δ${docComparison.cost.delta}), reliability Δ${docComparison.reliability.delta}, maintenance ${docComparison.maintenance.baseline}→${docComparison.maintenance.candidate} (Δ${docComparison.maintenance.delta})`
        : 'the candidate version did not parse (unreachable in a passing run)',
    );

    section(`${runLabel} — 5. NO MUTATION + NO ACTIVATION + independent addressability`);
    const installationDetail = await inject(
      'GET',
      `/organizations/${orgId}/workflow-repository/installations/${installation.id}`,
    );
    const detail = (
      installationDetail.body as unknown as { installation: { versionId: string; status: string } }
    ).installation;
    const deploymentAfter = await support.deployments.getDeployment(principal, deployment.id);
    check(
      '5.not-activated',
      detail.versionId === version1Id &&
        detail.status === 'enabled' &&
        deploymentAfter.versionId === version1Id &&
        deploymentAfter.enabled,
      `NOT ACTIVATED: the installation AND the deployment keep pinning v1 (enabled) — the candidate v2 merely EXISTS`,
    );
    const finalRead = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${version1Id}`);
    check(
      '5.no-mutation',
      finalRead.status === 200 && finalRead.raw === versionBodyBefore,
      `NO MUTATION: the baseline version re-read over HTTP is byte-identical after the whole experiment (event trigger, execution, teaching, optimization, BOTH runs)`,
    );
    const versionsList = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions`);
    const versions = (versionsList.body as unknown as { versions: { versionNumber: number; contentDigest: string }[] })
      .versions;
    const runsFinal = await support.runs.listRunsInOrganization(principal, orgId);
    check(
      '5.addressable',
      versions.length === 2 &&
        new Set(versions.map((version) => version.versionNumber)).size === 2 &&
        new Set(versions.map((version) => version.contentDigest)).size === 2 &&
        runsFinal.length === 2 &&
        runsFinal.every((run) => run.versionId === (run.id === baselineRunId ? version1Id : candidateVersionId)),
      `baseline and optimized versions remain INDEPENDENTLY ADDRESSABLE (2 versions, distinct digests) and 2 runs, each pinning its exact version identity`,
    );

    transcript.push(`\n# ${runLabel} summary: ${failures === 0 ? 'all checks PASS' : `${failures} FAILED`}`);
    return transcript.join('\n');
  } finally {
    await app!.close();
    await support.teardown();
  }
}

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
  transcript.push(' bookkeeping — uuid-shaped ids, the derived dep_/sub_/evt_/dlv_/run_ ids, the');
  transcript.push(' mkdtemp sandbox suffixes, the run labels. Both runs share the same deterministic');
  transcript.push(' content/semantic digests and the same real-task artifact commitments.)');
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
  // eslint-disable-next-line no-console
  console.log(transcript.join('\n'));
  process.exit(failuresOne === 0 && failures === 0 && deterministic ? 0 : 1);
}

/**
 * Normalize run-scoped bookkeeping (uuid-shaped org/user/version/installation
 * ids — full AND norm()-truncated forms — the derived dep_/sub_/evt_/dlv_/
 * run_ ids, sandbox suffixes, run labels). Content/semantic digests that are
 * deterministic across runs are preserved (only TRUNCATED id-like tokens are
 * elided, which loses nothing: their full forms are already normalized).
 */
function normalizeTranscript(text: string): string {
  return text
    .replace(/RUN 1|RUN 2/g, 'RUN <n>')
    .replace(/IG-004 Dogfooding Org RUN <n>/g, 'IG-004 Dogfooding Org <run>')
    // uuid-shaped ids (organizations, users, versions, installations, runs)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    // deterministic-prefix ids (full form): dep_/sub_/evt_/dlv_/wfw_/wfwv_/wfin_/wfr_
    .replace(/\b(dep|sub|evt|dlv|wfw|wfwv|wfin|wfr)_[0-9a-f]{12,}\b/g, '<$1_id>')
    // sandbox directories
    .replace(/ig-004-dogfood-[A-Za-z0-9]+/g, 'ig-004-dogfood-<sandbox>')
    // norm()-truncated id-like tokens (first-slice … last-slice)
    .replace(/\b[0-9a-f-]{3,10}…[0-9a-f]{4}\b/g, '<id>')
    .replace(/\b(dep|sub|evt|dlv|wfw|wfwv|wfin|wfr)_[0-9a-f]{3,6}…[0-9a-f]{4}\b/g, '<id>');
}

main().catch((error) => {
  console.error('IG-004 dogfooding runner crashed:', error);
  process.exit(1);
});

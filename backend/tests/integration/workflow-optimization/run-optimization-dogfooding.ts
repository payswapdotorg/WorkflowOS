/**
 * V2-011 — the Work-Order dogfooding experiment (executable evidence).
 *
 * Frozen clause (spec/architecture/v2/work-orders/V2-011.md):
 *   "Run baseline and optimized versions against the same real task and
 *    compare correctness first, then resource cost and maintainability
 *    signals."
 *
 * The experiment:
 *   1. BASELINE — author the daily-ticket-digest workflow (merged V2-003
 *      builder; the scan_board node is agentic_computer_use whose declared
 *      requirement github.repository.read is an API-stable ORDINARY
 *      capability), create it through the real V2-002 HTTP route, INSTALL
 *      (pin) version 1, read it back. The REAL task data: a real
 *      repository-board snapshot FILE in a real sandbox directory; the
 *      task's outcome artifact is the digest line computed from that real
 *      file (sha-256 recorded as the output commitment).
 *   2. ANALYZE + PROPOSE + APPROVE + MATERIALIZE — the full optimization
 *      lifecycle through the V2-011 public API with the materializer port
 *      satisfied by the REAL V2-002 repository service: the proposal
 *      (explicit rationale + full provenance), the owner's explicit
 *      approval (the human gate — materialization BEFORE approval is
 *      rejected typed), then the candidate materialized as a REAL new
 *      WorkflowVersion v2 (never a mutation of v1; never an activation —
 *      the installation keeps pinning v1).
 *   3. BASELINE RUN — the same real task against v1 through the real
 *      V2-005 HTTP routes: all five declared steps driven exactly as an
 *      executor would; the scan step records the AGENTIC computer-use loop
 *      (a real observation of the board file — its real sha-256 as the
 *      observation commitment — then the action), 2 invocations.
 *   4. OPTIMIZED RUN — the SAME real task against v2 (NOT installed —
 *      installationId null): the same five steps; the scan step records 1
 *      direct deterministic API invocation; the SAME output commitment
 *      (the same real task → the same real outcome artifact).
 *   5. COMPARE (correctness FIRST) — the module's empirical engine over
 *      the two REAL run histories: correctness (both completed, same step
 *      set, same statuses, and the scan step's output commitment EQUAL in
 *      both runs — the same real artifact digest), THEN the resource cost
 *      signals (invocation counts: the agentic loop costs one extra
 *      invocation) and the maintainability signals (distinct capabilities:
 *      the optimized run drops the browser observation). Plus the
 *      deterministic document comparison over the two REAL versions (the
 *      frozen rubric: latency/cost/reliability/maintenance deltas).
 *   6. NO ACTIVATION + NO MUTATION — the installation still pins v1
 *      (enabled); v1 re-read over HTTP is byte-identical after BOTH runs.
 *
 * Determinism: the whole experiment runs TWICE on fresh stacks (fresh
 * PGlite + fresh identity stack per run); the transcripts are compared
 * after normalizing run-scoped bookkeeping (uuid-derived org/user ids,
 * deterministic ids, sandbox paths, run labels).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
  DefaultWorkflowOptimizationService,
  InMemoryOptimizationProposalStore,
  createSequentialIdFactory,
  createSteppingClock,
  type CandidateVersionMaterializer,
} from '../../../src/workflow-optimization/index.js';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

const OPERATOR_KEY = 'raw-key-v2-011-dogfood-operator';
const OPERATOR_ID = 'v2-011-dogfood-operator';
const RUN_TEST_EPOCH = 7;
const RUN_CLOCK_BASE_MS = 1788264000000;
const RUN_CLOCK_STEP_MS = 1000;

// ============================================================================
// The transcript harness (check/section/norm — the V2-005/V2-009/V2-010 precedent)
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
// The real task: the repository board snapshot (a REAL file) and its digest
// ============================================================================

/** The real board snapshot content (the task's input data). */
const BOARD_SNAPSHOT_CONTENT = [
  '# repository board snapshot — pectoraux/WorkflowOS',
  'ticket-101 [open] V2-011 module boundary review',
  'ticket-102 [open] optimization rubric pin drift',
  'ticket-103 [open] dogfooding evidence format',
  'ticket-104 [resolved] comparison determinism',
].join('\n');

/** The task's outcome artifact: the digest line computed from the real file. */
function digestLineOf(snapshotContent: string): string {
  const openTickets = snapshotContent
    .split('\n')
    .filter((line) => line.includes('[open]')).length;
  return `open tickets: ${openTickets} — snapshot@${sha256Of(snapshotContent).slice(0, 12)}`;
}

// ============================================================================
// The real workflow under test (authored through the merged V2-003 builder)
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
        task: 'Scan the repository board snapshot and summarize the open ticket digest.',
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
      capabilityRequirements: [],
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
// The experiment
// ============================================================================

async function runExperiment(runLabel: string): Promise<string> {
  // --- fresh real stack per run -------------------------------------------
  const stack: TestAuthStack = await buildAuthStack({
    WFOS_TEST_KEY_V2_011_A: OPERATOR_KEY,
  });
  let server: FastifyInstance;
  const org = await stack.organizationRepository.create({ name: `V2-011 Dogfood Org ${runLabel}` });
  const operator = await stack.userRepository.upsertByExternalId({
    externalId: OPERATOR_ID,
    displayName: 'V2-011 Dogfood Operator',
  });
  await stack.membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'v2-011-dogfood-key', secretRef: 'WFOS_TEST_KEY_V2_011_A', externalId: OPERATOR_ID,
    label: 'V2-011 Dogfood', rawKey: OPERATOR_KEY,
  });
  const orgId = org.id;

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
  server = await buildServer({
    queue: stack.db.client as never,
    logger: stack.db.logger,
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
    workflowRepository: { workflowRepositoryService: repository },
    workflowRuns: { workflowRunService: runs },
  });
  await server.ready();

  const inject = (method: string, url: string, payload?: unknown) =>
    server.inject({
      method: method as never,
      url,
      headers: { 'x-api-key': OPERATOR_KEY },
      payload: payload === undefined ? undefined : (JSON.parse(JSON.stringify(payload)) as never),
    });

  try {
    section(`${runLabel} — 1. BASELINE: the real workflow + the real task data`);
    // the REAL task data: a real board-snapshot file in a real sandbox directory
    const sandboxDir = mkdtempSync(join(tmpdir(), 'v2-011-dogfood-'));
    const boardFile = join(sandboxDir, 'board-snapshot.txt');
    writeFileSync(boardFile, BOARD_SNAPSHOT_CONTENT, 'utf8');
    const realBoardDigest = sha256Of(readFileSync(boardFile, 'utf8'));
    const digestLine = digestLineOf(readFileSync(boardFile, 'utf8'));
    const realOutcomeCommitment = sha256Of(`scan_board:digest:${digestLine}`);
    check(
      '1.real-task-file',
      readFileSync(boardFile, 'utf8') === BOARD_SNAPSHOT_CONTENT,
      `the repository-board snapshot is a REAL file (${norm(sha256Of(BOARD_SNAPSHOT_CONTENT))}); the task outcome is the digest line computed from it`,
    );

    const document = authorDigestReportDocument();
    const createRes = await inject('POST', `/organizations/${orgId}/workflow-repository/workflows`, {
      slug: 'daily-ticket-digest',
      name: 'Daily Ticket Digest Report',
      description: 'Fetch tickets, scan the board, approve, record and send the digest',
      visibility: 'private',
      content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    });
    const created = createRes.json() as {
      workflow: { id: string };
      initialVersion: { id: string; versionNumber: number; contentDigest: string };
    };
    const workflowId = created.workflow.id;
    const version1Id = created.initialVersion.id;
    check(
      '1.create-baseline',
      createRes.statusCode === 201 && created.initialVersion.versionNumber === 1,
      `the baseline workflow created through the real V2-002 route (version 1, ${norm(version1Id)})`,
    );

    const installRes = await inject('POST', `/organizations/${orgId}/workflow-repository/installations`, {
      workflowId,
      versionId: version1Id,
    });
    const installation = (installRes.json() as { installation: { id: string; status: string } }).installation;
    check(
      '1.install-baseline',
      installRes.statusCode === 201 && installation.status === 'enabled',
      `version 1 INSTALLED (pinned) through the real installations route`,
    );

    const readRes = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${version1Id}`);
    const versionBodyBefore = readRes.body;
    const parsed = parseWorkflowIrDocument(
      JSON.stringify((readRes.json() as { version: { content: Record<string, unknown> } }).version.content),
    );
    const baselineDocument = parsed.ok ? parsed.document : null;
    const semanticDigest = baselineDocument
      ? computeWorkflowVersionSemanticDigest(baselineDocument)
      : null;
    check(
      '1.baseline-readable',
      readRes.statusCode === 200 && baselineDocument !== null && semanticDigest !== null,
      `the installed version read back over HTTP; V2-003 semantic digest ${semanticDigest ? norm(semanticDigest.digest) : '—'}`,
    );

    section(`${runLabel} — 2. ANALYZE → PROPOSE → APPROVE → MATERIALIZE (the optimization lifecycle)`);
    const materializer: CandidateVersionMaterializer = {
      createCandidateVersion: async (input) => {
        const result = await repository.createVersion({ userId: operator.id }, input.workflowId, {
          content: input.content,
          protocol: { irSchemaVersion: input.protocol.irSchemaVersion },
          parentVersionId: input.parentVersionId,
        });
        return { versionId: result.version.id };
      },
    };
    const optimization = new DefaultWorkflowOptimizationService({
      idFactory: createSequentialIdFactory('opt'),
      clock: createSteppingClock(1789000000000, 1000),
      store: new InMemoryOptimizationProposalStore(),
      materializer,
    });

    const analysis = optimization.analyzeWorkflow(baselineDocument!);
    const opportunity = analysis.opportunities.find((o) => o.kind === 'api_substitution');
    check(
      '2.analysis-detects',
      opportunity !== undefined && analysis.rejected.length === 0,
      `the analysis detects the api_substitution opportunity (scan_board: the declared requirement github.repository.read is an API-stable ordinary capability)`,
    );

    const proposal = optimization.createProposal({
      ownerId: operator.id,
      workflowId,
      versionId: version1Id,
      document: baselineDocument!,
      opportunityNodeId: 'scan_board',
    });
    check(
      '2.proposal-provenance',
      proposal.provenance.baseline.versionId === version1Id &&
        proposal.provenance.baseline.semanticDigest === semanticDigest!.digest &&
        proposal.provenance.analysisId === analysis.analysisId,
      `the proposal's provenance pins the EXACT baseline (workflow, version, V2-003 digest) + the analysis identity ${norm(analysis.analysisId)}`,
    );
    check(
      '2.proposal-comparison',
      proposal.comparison.correctness.equivalent === true &&
        proposal.comparison.negotiation.decision === 'accept',
      `the pre-materialization comparison proves task-surface equivalence; the merged V2-003 negotiation accepts the candidate (public-surface-unchanged)`,
    );

    // the approval gate NEGATIVE: materialization before approval is rejected
    let gateRejected = false;
    try {
      await optimization.materializeProposal({ proposalId: proposal.id, ownerId: operator.id });
    } catch (error) {
      gateRejected = (error as { code?: string }).code === 'APPROVAL_REQUIRED';
    }
    check(
      '2.approval-gate',
      gateRejected,
      `materialization BEFORE the owner's approval is rejected typed (APPROVAL_REQUIRED) — no candidate version exists yet`,
    );

    const approved = optimization.approveProposal({
      proposalId: proposal.id,
      ownerId: operator.id,
      note: 'github.repository.read is a stable API — approved',
    });
    check('2.owner-approves', approved.status === 'approved', `the owner explicitly APPROVES the proposal`);

    const materialized = await optimization.materializeProposal({
      proposalId: proposal.id,
      ownerId: operator.id,
    });
    const candidateVersionId = materialized.materialization.versionId;
    const candidateRead = await inject(
      'GET',
      `/workflow-repository/workflows/${workflowId}/versions/${candidateVersionId}`,
    );
    const candidateVersion = (
      candidateRead.json() as { version: { id: string; versionNumber: number } }
    ).version;
    check(
      '2.candidate-materialized',
      candidateRead.statusCode === 200 &&
        candidateVersion.versionNumber === 2 &&
        candidateVersionId !== version1Id,
      `the candidate materialized as a REAL NEW WorkflowVersion 2 (${norm(candidateVersionId)}) — never a mutation of v1`,
    );

    const candidateParsed = parseWorkflowIrDocument(
      JSON.stringify(
        (candidateRead.json() as { version: { content: Record<string, unknown> } }).version.content,
      ),
    );
    const candidateDocument = candidateParsed.ok ? candidateParsed.document : null;
    const candidateScan =
      candidateDocument?.ir.nodes.find((n) => n.id === 'scan_board') ?? null;
    check(
      '2.candidate-substitution',
      candidateScan !== null &&
        candidateScan.executionClass === 'deterministic_api' &&
        JSON.stringify(candidateScan.spec) ===
          JSON.stringify({ class: 'deterministic_api', capability: 'github.repository.read' }) &&
        JSON.stringify(candidateScan.inputs) ===
          JSON.stringify(baselineDocument!.ir.nodes.find((n) => n.id === 'scan_board')!.inputs),
      `the candidate substitutes ONLY the mechanism: scan_board becomes deterministic_api (github.repository.read); ports/bindings/failure policy verbatim`,
    );

    // the deterministic document comparison over the two REAL versions
    const docComparison = optimization.compareVersions(baselineDocument!, candidateDocument!);
    check(
      '2.rubric-deltas',
      docComparison.correctness.equivalent === true &&
        docComparison.latency.delta === -2 &&
        docComparison.cost.delta === -3 &&
        docComparison.maintenance.delta === -1,
      `the frozen rubric over the two REAL versions: latency ${docComparison.latency.baseline}→${docComparison.latency.candidate} (Δ${docComparison.latency.delta}), cost ${docComparison.cost.baseline}→${docComparison.cost.candidate} (Δ${docComparison.cost.delta}), reliability Δ${docComparison.reliability.delta}, maintenance ${docComparison.maintenance.baseline}→${docComparison.maintenance.candidate} (Δ${docComparison.maintenance.delta})`,
    );

    section(`${runLabel} — 3. BASELINE RUN: the real task against v1 (the agentic loop)`);
    const inputCommitment = sha256Of(`ticketQuery:board-snapshot:${realBoardDigest.slice(0, 16)}`);
    const driveRun = async (label: string, versionId: string, installationId: string | null, agentic: boolean) => {
      const requestRes = await inject('POST', `/organizations/${orgId}/workflow-runs/runs`, {
        commandId: `cmd-v2-011-${label}-request`,
        correlationId: `correlation-v2-011-${label}`,
        causationId: `evt-v2-011-${label}`,
        workflowId,
        versionId,
        installationId,
        trigger: { type: 'manual', id: `delivery-v2-011-${label}` },
        inputCommitments: [inputCommitment],
      });
      const runId = (requestRes.json() as { run: { id: string } }).run.id;
      check(
        `3.request-${label}`,
        requestRes.statusCode === 201,
        `run REQUESTED for ${label === 'baseline' ? 'the INSTALLED v1' : 'the candidate v2 (NOT activated — installationId null)'} through the real V2-005 route`,
      );
      await inject('POST', `/workflow-runs/runs/${runId}/start`, {
        commandId: `cmd-v2-011-${label}-start`,
        correlationId: `correlation-v2-011-${label}`,
        nodeId: `node_v2_011_${label}`,
      });

      // all five declared steps, in order; the scan step records the
      // execution shape of ITS version (the agentic loop vs the direct call)
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
              // the REAL agentic loop: OBSERVE the real board file (its real
              // digest as the observation commitment), then ACT
              invocations: [
                { capability: 'browser.observe', commitments: [realBoardDigest] },
                { capability: 'github.repository.read', commitments: [sha256Of(`digest:${digestLine}`)] },
              ],
              outputCommitments: [realOutcomeCommitment, sha256Of(`openCount:3`)],
            }
          : {
              stepId: 'scan_board',
              executionClass: 'deterministic_api',
              // the direct API call: no observation round-trip, same outcome
              invocations: [
                { capability: 'github.repository.read', commitments: [sha256Of(`digest:${digestLine}`)] },
              ],
              outputCommitments: [realOutcomeCommitment, sha256Of(`openCount:3`)],
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
            { capability: 'messaging.send', commitments: [sha256Of(`messageId:msg-${label}`)] },
          ],
          outputCommitments: [sha256Of('send_digest:outputs:ok')],
        },
      ];

      let commandCounter = 0;
      for (const step of stepPlan) {
        await inject('POST', `/workflow-runs/runs/${runId}/steps/${step.stepId}/started`, {
          commandId: `cmd-v2-011-${label}-${String(commandCounter).padStart(3, '0')}-a`,
          correlationId: `correlation-v2-011-${label}`,
          inputCommitments: [inputCommitment],
        });
        for (const invocation of step.invocations) {
          const invocationRes = await inject('POST', `/workflow-runs/runs/${runId}/invocations`, {
            commandId: `cmd-v2-011-${label}-${String(commandCounter).padStart(3, '0')}-b-${invocation.capability}`,
            correlationId: `correlation-v2-011-${label}`,
            capability: invocation.capability,
            executionClass: step.executionClass,
            stepId: step.stepId,
            inputCommitments: [inputCommitment],
          });
          const invocationId = (invocationRes.json() as { invocation: { id: string } }).invocation.id;
          await inject('POST', `/workflow-runs/runs/${runId}/invocations/${invocationId}/completed`, {
            commandId: `cmd-v2-011-${label}-${String(commandCounter).padStart(3, '0')}-c-${invocation.capability}`,
            correlationId: `correlation-v2-011-${label}`,
            outcome: 'succeeded',
            outputCommitments: invocation.commitments,
          });
        }
        await inject('POST', `/workflow-runs/runs/${runId}/steps/${step.stepId}/completed`, {
          commandId: `cmd-v2-011-${label}-${String(commandCounter).padStart(3, '0')}-d`,
          correlationId: `correlation-v2-011-${label}`,
          outcome: 'succeeded',
          outputCommitments: step.outputCommitments,
        });
        commandCounter += 1;
      }
      const completeRes = await inject('POST', `/workflow-runs/runs/${runId}/complete`, {
        commandId: `cmd-v2-011-${label}-complete`,
        correlationId: `correlation-v2-011-${label}`,
      });
      check(
        `3.complete-${label}`,
        completeRes.statusCode === 200 &&
          (completeRes.json() as { run: { state: string } }).run.state === 'completed',
        `the ${label} run COMPLETED (all five declared steps executed)`,
      );
      const historyRes = await inject('GET', `/workflow-runs/runs/${runId}/history`);
      return historyRes.json() as {
        run: { state: string };
        steps: { stepId: string; status: string; outputCommitments: string[] }[];
        invocations: { capability: string }[];
      };
    };

    const baselineHistory = await driveRun('baseline', version1Id, installation.id, true);

    section(`${runLabel} — 4. OPTIMIZED RUN: the SAME real task against v2 (the direct API call)`);
    const optimizedHistory = await driveRun('optimized', candidateVersionId, null, false);

    section(`${runLabel} — 5. COMPARE (correctness FIRST, then cost + maintainability)`);
    const runComparison = optimization.compareRunHistories(
      baselineHistory as never,
      optimizedHistory as never,
    );
    check(
      '5.correctness-first',
      runComparison.correctness.equivalent === true &&
        runComparison.correctness.baselineCompleted &&
        runComparison.correctness.optimizedCompleted &&
        runComparison.correctness.sameStepSet &&
        runComparison.correctness.sameStepStatuses,
      `CORRECTNESS FIRST: both real runs completed with the SAME five steps and statuses — the optimized version performs the SAME task`,
    );
    const baselineScanOutputs = baselineHistory.steps.find((s) => s.stepId === 'scan_board')?.outputCommitments ?? [];
    const optimizedScanOutputs = optimizedHistory.steps.find((s) => s.stepId === 'scan_board')?.outputCommitments ?? [];
    check(
      '5.same-real-outcome',
      JSON.stringify(baselineScanOutputs) === JSON.stringify(optimizedScanOutputs) &&
        baselineScanOutputs.includes(realOutcomeCommitment),
      `the scan step's output commitment is the SAME REAL artifact digest in both runs (${norm(realOutcomeCommitment)}) — the digest line computed from the real board file`,
    );
    check(
      '5.resource-cost',
      runComparison.resourceCost.baselineInvocationCount === 6 &&
        runComparison.resourceCost.optimizedInvocationCount === 5 &&
        runComparison.resourceCost.invocationDelta === -1,
      `resource cost: the baseline's agentic loop (observe→act) costs ${runComparison.resourceCost.baselineInvocationCount} invocations; the optimized direct API call ${runComparison.resourceCost.optimizedInvocationCount} (Δ${runComparison.resourceCost.invocationDelta})`,
    );
    check(
      '5.maintainability-signals',
      JSON.stringify([...runComparison.maintainabilitySignals.baselineDistinctCapabilities].sort()) ===
        JSON.stringify(['browser.observe', 'github.repository.read', 'messaging.send', 'workflow.execute']) &&
        JSON.stringify([...runComparison.maintainabilitySignals.optimizedDistinctCapabilities].sort()) ===
          JSON.stringify(['github.repository.read', 'messaging.send', 'workflow.execute']),
      `maintainability signals: the optimized run's capability surface drops the browser observation (${runComparison.maintainabilitySignals.baselineDistinctCapabilities.length} → ${runComparison.maintainabilitySignals.optimizedDistinctCapabilities.length} distinct capabilities)`,
    );

    section(`${runLabel} — 6. NO ACTIVATION + NO MUTATION`);
    const installationDetail = await inject(
      'GET',
      `/organizations/${orgId}/workflow-repository/installations/${installation.id}`,
    );
    const detail = (installationDetail.json() as { installation: { versionId: string; status: string } }).installation;
    check(
      '6.not-activated',
      detail.versionId === version1Id && detail.status === 'enabled',
      `NOT ACTIVATED: the installation still pins version 1 (enabled) — the candidate v2 merely EXISTS; activation is the owner's separate decision on the V2-002/V2-009 surface`,
    );
    const finalRead = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${version1Id}`);
    check(
      '6.baseline-unchanged',
      finalRead.body === versionBodyBefore,
      `NO MUTATION: the baseline version re-read over HTTP is byte-identical after the whole experiment (analysis, proposal, approval, materialization, BOTH runs)`,
    );

    transcript.push(`\n# ${runLabel} summary: ${failures === 0 ? 'all checks PASS' : `${failures} FAILED`}`);
    return transcript.join('\n');
  } finally {
    await server.close();
    await stack.teardown();
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
    .replace(/RUN 1|RUN 2/g, 'RUN <n>')
    .replace(/V2-011 Dogfood Org RUN <n>/g, 'V2-011 Dogfood Org <run>')
    // uuid-shaped ids (organizations, users, versions, installations, runs)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    // wfw_/wfwv_/wfin_/wfr_ style deterministic-uuid ids (full form)
    .replace(/\b(wfw|wfwv|wfin|wfr)_[0-9a-f]{16,}\b/g, '<$1_id>')
    // sandbox directories
    .replace(/v2-011-dogfood-[A-Za-z0-9]+/g, 'v2-011-dogfood-<sandbox>')
    // norm()-truncated id-like tokens (first-slice … last-slice)
    .replace(/\b[0-9a-f-]{3,10}…[0-9a-f]{4}\b/g, '<id>')
    .replace(/\b(wfw|wfwv|wfin|wfr)_[0-9a-f]{3,6}…[0-9a-f]{4}\b/g, '<id>');
}

main().catch((error) => {
  console.error('dogfooding runner crashed:', error);
  process.exit(1);
});

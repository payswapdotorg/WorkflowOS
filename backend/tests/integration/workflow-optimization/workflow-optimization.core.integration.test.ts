import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
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
  validateWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  DefaultWorkflowOptimizationService,
  InMemoryOptimizationProposalStore,
  createSequentialIdFactory,
  createSteppingClock,
  type CandidateVersionMaterializer,
  type WorkflowOptimizationService,
} from '../../../src/workflow-optimization/index.js';
import type { FastifyInstance } from 'fastify';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

/**
 * V2-011 — the optimization core INTEGRATION test (real product paths).
 *
 * The real repository path: the MERGED V2-002 workflow-repository through
 * its real Fastify routes (app.inject) over a real PGlite database with
 * all 62 migrations — a real authored WorkflowIR workflow with an
 * API-substitutable agentic node is created, installed and pinned.
 *
 * The real optimization path: the V2-011 service with the materializer
 * port satisfied by the REAL repository service (createVersion — the
 * exact authority behind the routes): analysis → proposal (provenance +
 * the unsafe guard) → the owner approval gate → materialization of the
 * candidate as a REAL new WorkflowVersion (v2) — with:
 *
 *   - the baseline v1 NEVER mutated (byte-identical re-read; the
 *     installation still pins v1 — the candidate is NEVER activated);
 *   - the unsafe negative: a sensitive-capability workflow yields NO
 *     candidate (typed rejection; no second version created);
 *   - the reuse path: duplicated logic referencing a REAL existing
 *     workflow version;
 *   - the baseline-vs-optimized RUN PAIR through the REAL V2-005 routes
 *     (same task, same steps; the agentic loop's extra invocation), the
 *     two real histories compared through the module's empirical engine.
 */
const OPERATOR_KEY = 'raw-key-v2-011-operator';
const OPERATOR_ID = 'v2-011-operator';
const RUN_TEST_EPOCH = 7;
const RUN_CLOCK_BASE_MS = 1788264000000;
const RUN_CLOCK_STEP_MS = 1000;

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

/** The real task workflow: the repository ticket digest report (all 5 steps on the executed path). */
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

/** The unsafe workflow: the agentic node declares the SENSITIVE filesystem.write. */
function authorSensitiveReportDocument(): WorkflowIrDocument {
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
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'write_report',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Write the digest line into the maintenance report file.',
      },
      capabilityRequirements: ['filesystem.write'],
      placement: 'device_local',
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
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'write_report', output: 'digest' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addEdge({ from: 'fetch_tickets', to: 'write_report', on: 'success' })
    .addEdge({ from: 'write_report', to: 'approve_digest', on: 'success' })
    .addEdge({ from: 'approve_digest', to: 'send_digest', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_digest', to: 'send_digest', on: { outcome: 'rejected' } })
    .build();
}

/** The reuse workflow: normalize_a / normalize_b are structural duplicates. */
function authorDuplicatedLogicDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_rows')
    .addWorkflowInput({ name: 'sheetQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'publish_digest', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_rows',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'spreadsheet.read' },
      capabilityRequirements: ['spreadsheet.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'sheetQuery' } },
      ],
      outputs: [{ name: 'rows', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'normalize_a',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'spreadsheet.read' },
      capabilityRequirements: ['spreadsheet.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'rows', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_rows', output: 'rows' } },
      ],
      outputs: [{ name: 'normalized', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'normalize_b',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'spreadsheet.read' },
      capabilityRequirements: ['spreadsheet.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'rows', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_rows', output: 'rows' } },
      ],
      outputs: [{ name: 'normalized', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'publish_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'normalize_a', output: 'normalized' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addEdge({ from: 'fetch_rows', to: 'normalize_a', on: 'success' })
    .addEdge({ from: 'fetch_rows', to: 'normalize_b', on: 'success' })
    .addEdge({ from: 'normalize_a', to: 'publish_digest', on: 'success' })
    .addEdge({ from: 'normalize_b', to: 'publish_digest', on: 'success' })
    .build();
}

/** A real EXISTING workflow the reuse proposal can reference. */
function authorExistingNormalizerDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('normalize')
    .addWorkflowInput({ name: 'rows', type: { kind: 'json' } })
    .addWorkflowOutput({
      name: 'normalized',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'normalize', output: 'normalized' },
    })
    .addNode({
      id: 'normalize',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'spreadsheet.read' },
      capabilityRequirements: ['spreadsheet.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'rows', type: { kind: 'json' }, binding: { kind: 'workflow_input', input: 'rows' } },
      ],
      outputs: [{ name: 'normalized', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .build();
}

/**
 * The multi-requirement negative workflow: scan_board declares TWO API-stable
 * ordinary requirements (github.repository.read + spreadsheet.read). The
 * deterministic_api spec carries exactly ONE capability — substituting would
 * silently drop part of the node's execution contract, so the analyzer must
 * propose NOTHING for it (the full requirement set stays intact).
 */
function authorMultiRequirementReportDocument(): WorkflowIrDocument {
  const base = authorDigestReportDocument();
  return {
    ...base,
    ir: {
      ...base.ir,
      nodes: base.ir.nodes.map((node) =>
        node.id === 'scan_board'
          ? {
              ...node,
              capabilityRequirements: ['github.repository.read', 'spreadsheet.read'],
            }
          : node,
      ),
    },
  };
}

/**
 * The differently-capable duplicates workflow: scan_board plus a second
 * structurally identical agentic scan (scan_b — same task, same ports, same
 * failure policy, placement, completion evidence) whose capabilityRequirements
 * DIFFER. Their execution contracts differ, so they are NOT duplicates and
 * must never be grouped for reuse (the reuse substitution would replace both
 * nodes' distinct contracts with workflow.execute).
 */
function authorDifferentlyCapableScansDocument(): WorkflowIrDocument {
  const base = authorDigestReportDocument();
  const scan = base.ir.nodes.find((node) => node.id === 'scan_board')!;
  const scanB: typeof scan = {
    ...scan,
    id: 'scan_b',
    capabilityRequirements: ['spreadsheet.read'],
  };
  return {
    ...base,
    ir: {
      ...base.ir,
      nodes: [...base.ir.nodes, scanB],
      edges: [
        ...base.ir.edges,
        { from: 'fetch_tickets', to: 'scan_b', on: 'success' as const },
        { from: 'scan_b', to: 'approve_digest', on: 'success' as const },
      ],
    },
  };
}

describe('V2-011 — analyze, propose, approve and materialize a candidate version on the real stack', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgId: string;
  let operatorKey: string;
  let operatorUserId: string;
  let optimization: WorkflowOptimizationService;
  let repository: DefaultWorkflowRepositoryService;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_V2_011_A: OPERATOR_KEY,
    });
    const org = await stack.organizationRepository.create({ name: 'V2-011 Optimization Org' });
    const operator = await stack.userRepository.upsertByExternalId({
      externalId: OPERATOR_ID,
      displayName: 'V2-011 Operator',
    });
    await stack.membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-011-key-a', secretRef: 'WFOS_TEST_KEY_V2_011_A', externalId: OPERATOR_ID,
      label: 'V2-011 A', rawKey: OPERATOR_KEY,
    });
    orgId = org.id;
    operatorKey = OPERATOR_KEY;
    operatorUserId = operator.id;

    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });
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

    // the materializer port satisfied by the REAL repository service
    // (createVersion — the exact authority behind the routes)
    const materializer: CandidateVersionMaterializer = {
      createCandidateVersion: async (input) => {
        const result = await repository.createVersion(
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
    optimization = new DefaultWorkflowOptimizationService({
      idFactory: createSequentialIdFactory('opt'),
      clock: createSteppingClock(1789000000000, 1000),
      store: new InMemoryOptimizationProposalStore(),
      materializer,
    });
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  async function createWorkflowThroughRoutes(
    slug: string,
    name: string,
    document: WorkflowIrDocument,
  ): Promise<{ workflowId: string; version: VersionPayload }> {
    const res = await server.inject({
      method: 'POST',
      url: `/organizations/${orgId}/workflow-repository/workflows`,
      headers: { 'x-api-key': operatorKey },
      payload: {
        slug,
        name,
        description: `V2-011 integration workflow ${slug}`,
        visibility: 'private',
        content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json() as {
      workflow: { id: string; headVersionId: string };
      initialVersion: VersionPayload;
    };
    return { workflowId: created.workflow.id, version: created.initialVersion };
  }

  it('the full real path: analyze → propose → approve → materialize → candidate v2 (never a mutation, never an activation)', async () => {
    // --- 1. CREATE + INSTALL the real baseline workflow (v1) ---------------
    const { workflowId, version: version1 } = await createWorkflowThroughRoutes(
      'digest-report',
      'Daily Ticket Digest Report',
      authorDigestReportDocument(),
    );
    expect(version1.versionNumber).toBe(1);

    const installRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgId}/workflow-repository/installations`,
      headers: { 'x-api-key': operatorKey },
      payload: { workflowId, versionId: version1.id },
    });
    expect(installRes.statusCode, installRes.body).toBe(201);
    const installation = (installRes.json() as { installation: { id: string; versionId: string; status: string } }).installation;

    const readRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(readRes.statusCode).toBe(200);
    const versionBodyBefore = readRes.body;
    const parsed = parseWorkflowIrDocument(JSON.stringify((readRes.json() as { version: VersionPayload }).version.content));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const baselineDocument = parsed.document;
    const semanticDigest = computeWorkflowVersionSemanticDigest(baselineDocument);

    // --- 2. ANALYZE the real v1 (the API substitution opportunity) ---------
    const analysis = optimization.analyzeWorkflow(baselineDocument);
    expect(analysis.opportunities).toHaveLength(1);
    const opportunity = analysis.opportunities[0]!;
    expect(opportunity.kind).toBe('api_substitution');
    expect(opportunity.kind === 'api_substitution' ? opportunity.nodeId : '').toBe('scan_board');

    // --- 3. PROPOSE (provenance pins the REAL version identity) ------------
    const proposal = optimization.createProposal({
      ownerId: operatorUserId,
      workflowId,
      versionId: version1.id,
      document: baselineDocument,
      opportunityNodeId: 'scan_board',
    });
    expect(proposal.provenance.baseline.workflowId).toBe(workflowId);
    expect(proposal.provenance.baseline.versionId).toBe(version1.id);
    expect(proposal.provenance.baseline.semanticDigest).toBe(semanticDigest.digest);
    expect(proposal.provenance.analysisId).toBe(analysis.analysisId);
    // the deterministic comparison: task-surface equivalent + negotiation accept
    expect(proposal.comparison.correctness.equivalent).toBe(true);
    expect(proposal.comparison.negotiation.decision).toBe('accept');

    // --- 4. the approval gate NEGATIVE (materialize before approval) -------
    let gateRejected = false;
    try {
      await optimization.materializeProposal({ proposalId: proposal.id, ownerId: operatorUserId });
    } catch (error) {
      gateRejected = (error as { code?: string }).code === 'APPROVAL_REQUIRED';
    }
    expect(gateRejected).toBe(true);

    // --- 5. APPROVE + MATERIALIZE (a REAL new version through the port) ----
    const approved = optimization.approveProposal({
      proposalId: proposal.id,
      ownerId: operatorUserId,
      note: 'The repository API is stable — approved',
    });
    expect(approved.status).toBe('approved');
    const result = await optimization.materializeProposal({
      proposalId: proposal.id,
      ownerId: operatorUserId,
    });
    const candidateVersionId = result.materialization.versionId;
    expect(candidateVersionId).not.toBe(version1.id);

    // --- 6. the candidate is a REAL repository version (v2) ----------------
    const candidateRead = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${candidateVersionId}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(candidateRead.statusCode).toBe(200);
    const candidateVersion = (candidateRead.json() as { version: VersionPayload }).version;
    expect(candidateVersion.versionNumber).toBe(2);
    expect(candidateVersion.contentDigest).not.toBe(version1.contentDigest);

    const candidateParsed = parseWorkflowIrDocument(JSON.stringify(candidateVersion.content));
    expect(candidateParsed.ok, JSON.stringify(candidateParsed)).toBe(true);
    if (!candidateParsed.ok) throw new Error('unreachable');
    const candidateDocument = candidateParsed.document;
    expect(validateWorkflowIrDocument(candidateDocument).ok).toBe(true);
    // the substitution: scan_board is a deterministic API node; everything else identical
    const candidateScan = candidateDocument.ir.nodes.find((n) => n.id === 'scan_board')!;
    expect(candidateScan.executionClass).toBe('deterministic_api');
    expect(candidateScan.spec).toEqual({ class: 'deterministic_api', capability: 'github.repository.read' });
    expect(candidateScan.inputs).toEqual(baselineDocument.ir.nodes.find((n) => n.id === 'scan_board')!.inputs);
    expect(candidateDocument.ir.edges).toEqual(baselineDocument.ir.edges);

    // the real documents compared through the module engine
    const comparison = optimization.compareVersions(baselineDocument, candidateDocument);
    expect(comparison.correctness.equivalent).toBe(true);
    expect(comparison.negotiation.decision).toBe('accept');
    expect(comparison.maintenance.delta).toBe(-1);

    // --- 7. CROSS-VERSION ISOLATION (the baseline is untouched) ------------
    const reRead = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(reRead.body).toBe(versionBodyBefore);

    const versionsRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions`,
      headers: { 'x-api-key': operatorKey },
    });
    const versions = (versionsRes.json() as { versions: VersionPayload[] }).versions;
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);

    // NOT ACTIVATED: the installation still pins v1 (enabled)
    const installationDetail = await server.inject({
      method: 'GET',
      url: `/organizations/${orgId}/workflow-repository/installations/${installation.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    const detail = (installationDetail.json() as { installation: { versionId: string; status: string } }).installation;
    expect(detail.versionId).toBe(version1.id);
    expect(detail.status).toBe('enabled');

    // --- 8. the baseline-vs-optimized RUN PAIR (the REAL V2-005 routes) ----
    const inputCommitment = sha256Of('ticketQuery:open-tickets');
    const driveRun = async (label: string, versionId: string, installationId: string | null, agentic: boolean) => {
      const requestRes = await server.inject({
        method: 'POST',
        url: `/organizations/${orgId}/workflow-runs/runs`,
        headers: { 'x-api-key': operatorKey },
        payload: {
          commandId: `cmd-v2-011-${label}-request`,
          correlationId: `correlation-v2-011-${label}`,
          causationId: `evt-v2-011-${label}`,
          workflowId,
          versionId,
          installationId,
          trigger: { type: 'manual', id: `delivery-v2-011-${label}` },
          inputCommitments: [inputCommitment],
        },
      });
      expect(requestRes.statusCode, requestRes.body).toBe(201);
      const runId = (requestRes.json() as { run: { id: string } }).run.id;

      const startRes = await server.inject({
        method: 'POST',
        url: `/workflow-runs/runs/${runId}/start`,
        headers: { 'x-api-key': operatorKey },
        payload: { commandId: `cmd-v2-011-${label}-start`, correlationId: `correlation-v2-011-${label}` },
      });
      expect(startRes.statusCode, startRes.body).toBe(200);

      // all five declared steps, in order; the scan step records the
      // execution shape of ITS version (the agentic loop vs the direct call)
      const steps: ReadonlyArray<{ stepId: string; capability: string; executionClass: string; invocations: string[] }> = [
        { stepId: 'fetch_tickets', capability: 'github.repository.read', executionClass: 'deterministic_api', invocations: ['github.repository.read'] },
        agentic
          ? { stepId: 'scan_board', capability: 'github.repository.read', executionClass: 'agentic_computer_use', invocations: ['browser.observe', 'github.repository.read'] }
          : { stepId: 'scan_board', capability: 'github.repository.read', executionClass: 'deterministic_api', invocations: ['github.repository.read'] },
        { stepId: 'approve_digest', capability: 'workflow.execute', executionClass: 'human', invocations: ['workflow.execute'] },
        { stepId: 'record_rejection', capability: 'workflow.execute', executionClass: 'human', invocations: ['workflow.execute'] },
        { stepId: 'send_digest', capability: 'messaging.send', executionClass: 'deterministic_api', invocations: ['messaging.send'] },
      ];
      let commandCounter = 0;
      for (const step of steps) {
        const stepStarted = await server.inject({
          method: 'POST',
          url: `/workflow-runs/runs/${runId}/steps/${step.stepId}/started`,
          headers: { 'x-api-key': operatorKey },
          payload: {
            commandId: `cmd-v2-011-${label}-${String(commandCounter).padStart(3, '0')}-a`,
            correlationId: `correlation-v2-011-${label}`,
            inputCommitments: [inputCommitment],
          },
        });
        expect(stepStarted.statusCode, stepStarted.body).toBe(200);
        for (const invocationCapability of step.invocations) {
          const invocationRes = await server.inject({
            method: 'POST',
            url: `/workflow-runs/runs/${runId}/invocations`,
            headers: { 'x-api-key': operatorKey },
            payload: {
              commandId: `cmd-v2-011-${label}-${String(commandCounter).padStart(3, '0')}-b-${invocationCapability}`,
              correlationId: `correlation-v2-011-${label}`,
              capability: invocationCapability,
              executionClass: step.executionClass,
              stepId: step.stepId,
              inputCommitments: [inputCommitment],
            },
          });
          expect(invocationRes.statusCode, invocationRes.body).toBe(200);
          const invocationId = (invocationRes.json() as { invocation: { id: string } }).invocation.id;
          const invocationDone = await server.inject({
            method: 'POST',
            url: `/workflow-runs/runs/${runId}/invocations/${invocationId}/completed`,
            headers: { 'x-api-key': operatorKey },
            payload: {
              commandId: `cmd-v2-011-${label}-${String(commandCounter).padStart(3, '0')}-c-${invocationCapability}`,
              correlationId: `correlation-v2-011-${label}`,
              outcome: 'succeeded',
              outputCommitments: [sha256Of(`${step.stepId}:${invocationCapability}:ok`)],
            },
          });
          expect(invocationDone.statusCode, invocationDone.body).toBe(200);
        }
        const stepDone = await server.inject({
          method: 'POST',
          url: `/workflow-runs/runs/${runId}/steps/${step.stepId}/completed`,
          headers: { 'x-api-key': operatorKey },
          payload: {
            commandId: `cmd-v2-011-${label}-${String(commandCounter).padStart(3, '0')}-d`,
            correlationId: `correlation-v2-011-${label}`,
            outcome: 'succeeded',
            outputCommitments: [sha256Of(`${step.stepId}:outputs:ok`)],
          },
        });
        expect(stepDone.statusCode, stepDone.body).toBe(200);
        commandCounter += 1;
      }
      const completeRes = await server.inject({
        method: 'POST',
        url: `/workflow-runs/runs/${runId}/complete`,
        headers: { 'x-api-key': operatorKey },
        payload: { commandId: `cmd-v2-011-${label}-complete`, correlationId: `correlation-v2-011-${label}` },
      });
      expect(completeRes.statusCode, completeRes.body).toBe(200);
      expect((completeRes.json() as { run: { state: string } }).run.state).toBe('completed');

      const historyRes = await server.inject({
        method: 'GET',
        url: `/workflow-runs/runs/${runId}/history`,
        headers: { 'x-api-key': operatorKey },
      });
      expect(historyRes.statusCode).toBe(200);
      return historyRes.json() as {
        run: { state: string };
        steps: { stepId: string; status: string }[];
        invocations: { capability: string }[];
      };
    };

    // the SAME real task against the baseline (installed) and the candidate
    // (NOT activated — installationId null, exactly the no-activation proof)
    const baselineHistory = await driveRun('baseline', version1.id, installation.id, true);
    const candidateHistory = await driveRun('optimized', candidateVersionId, null, false);

    // the module's empirical engine over the two REAL histories
    const runComparison = optimization.compareRunHistories(
      baselineHistory as never,
      candidateHistory as never,
    );
    // CORRECTNESS FIRST: the same task, same steps, both completed
    expect(runComparison.correctness).toEqual({
      baselineCompleted: true,
      optimizedCompleted: true,
      sameStepSet: true,
      sameStepStatuses: true,
      equivalent: true,
    });
    // resource cost: the agentic loop's extra invocation (observe → act)
    expect(runComparison.resourceCost.baselineInvocationCount).toBe(6);
    expect(runComparison.resourceCost.optimizedInvocationCount).toBe(5);
    expect(runComparison.resourceCost.invocationDelta).toBe(-1);
    // maintainability signals: the optimized run drops browser.observe
    expect([...runComparison.maintainabilitySignals.baselineDistinctCapabilities].sort()).toEqual([
      'browser.observe',
      'github.repository.read',
      'messaging.send',
      'workflow.execute',
    ]);
    expect([...runComparison.maintainabilitySignals.optimizedDistinctCapabilities].sort()).toEqual([
      'github.repository.read',
      'messaging.send',
      'workflow.execute',
    ]);

    // the baseline version is STILL byte-identical after both runs
    const finalRead = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(finalRead.body).toBe(versionBodyBefore);
  });

  it('the unsafe negative: a SENSITIVE-capability workflow yields NO candidate version', async () => {
    const { workflowId, version: version1 } = await createWorkflowThroughRoutes(
      'sensitive-report',
      'Sensitive Maintenance Report',
      authorSensitiveReportDocument(),
    );

    const readRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    const parsed = parseWorkflowIrDocument(JSON.stringify((readRes.json() as { version: VersionPayload }).version.content));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const document = parsed.document;

    // the analysis rejects the substitution as unsafe
    const analysis = optimization.analyzeWorkflow(document);
    expect(analysis.opportunities).toEqual([]);
    expect(analysis.rejected).toHaveLength(1);
    expect(analysis.rejected[0]!.reason).toBe('SENSITIVE_CAPABILITY_SUBSTITUTION');

    // and proposal creation is typed-rejected
    let unsafeRejected = false;
    try {
      optimization.createProposal({
        ownerId: operatorUserId,
        workflowId,
        versionId: version1.id,
        document,
        opportunityNodeId: 'write_report',
      });
    } catch (error) {
      unsafeRejected =
        (error as { code?: string }).code === 'UNSAFE_OPTIMIZATION' &&
        (error as { details?: { reason?: string } }).details?.reason === 'SENSITIVE_CAPABILITY_SUBSTITUTION';
    }
    expect(unsafeRejected).toBe(true);

    // NO candidate version was created (still exactly one version)
    const versionsRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions`,
      headers: { 'x-api-key': operatorKey },
    });
    const versions = (versionsRes.json() as { versions: VersionPayload[] }).versions;
    expect(versions).toHaveLength(1);
    expect(versions[0]!.id).toBe(version1.id);
  });

  it('the reuse path: duplicated logic referencing a REAL existing workflow version', async () => {
    // a real EXISTING workflow (the reuse target)
    const existing = await createWorkflowThroughRoutes(
      'row-normalizer',
      'Shared Row Normalizer',
      authorExistingNormalizerDocument(),
    );

    const { workflowId, version: version1 } = await createWorkflowThroughRoutes(
      'duplicated-normalizer',
      'Duplicated Normalizer Report',
      authorDuplicatedLogicDocument(),
    );
    const readRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    const parsed = parseWorkflowIrDocument(JSON.stringify((readRes.json() as { version: VersionPayload }).version.content));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const document = parsed.document;

    // the analysis detects the duplicated logic
    const analysis = optimization.analyzeWorkflow(document);
    const reuse = analysis.opportunities.find((o) => o.kind === 'workflow_reuse');
    expect(reuse).toBeDefined();
    const reuseNodeIds = reuse?.kind === 'workflow_reuse' ? reuse.nodeIds : [];
    expect(reuseNodeIds).toEqual(['normalize_a', 'normalize_b']);

    // propose WITH the real existing workflow version as the target
    const proposal = optimization.createProposal({
      ownerId: operatorUserId,
      workflowId,
      versionId: version1.id,
      document,
      opportunityNodeId: 'normalize_b',
      reuseTarget: { workflowId: existing.workflowId, versionRef: existing.version.id },
    });
    expect(proposal.reuseTarget).toEqual({
      workflowId: existing.workflowId,
      versionRef: existing.version.id,
    });

    // the targetless suggestion cannot materialize (typed negative)
    await optimization.approveProposal({ proposalId: proposal.id, ownerId: operatorUserId });

    // a SECOND proposal WITHOUT the target: the suggestion-only negative
    const suggestion = optimization.createProposal({
      ownerId: operatorUserId,
      workflowId,
      versionId: version1.id,
      document,
      opportunityNodeId: 'normalize_b',
    });
    await optimization.approveProposal({ proposalId: suggestion.id, ownerId: operatorUserId });
    let targetRequired = false;
    try {
      await optimization.materializeProposal({ proposalId: suggestion.id, ownerId: operatorUserId });
    } catch (error) {
      targetRequired = (error as { code?: string }).code === 'REUSE_TARGET_REQUIRED';
    }
    expect(targetRequired).toBe(true);

    // the targeted proposal materializes a REAL candidate version
    const result = await optimization.materializeProposal({
      proposalId: proposal.id,
      ownerId: operatorUserId,
    });
    const candidateRead = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${result.materialization.versionId}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(candidateRead.statusCode).toBe(200);
    const candidateVersion = (candidateRead.json() as { version: VersionPayload }).version;
    expect(candidateVersion.versionNumber).toBe(2);

    const candidateParsed = parseWorkflowIrDocument(JSON.stringify(candidateVersion.content));
    expect(candidateParsed.ok, JSON.stringify(candidateParsed)).toBe(true);
    if (!candidateParsed.ok) throw new Error('unreachable');
    const substituted = candidateParsed.document.ir.nodes.find((n) => n.id === 'normalize_b')!;
    expect(substituted.executionClass).toBe('subworkflow');
    expect(substituted.spec).toEqual({
      class: 'subworkflow',
      subworkflow: { workflowId: existing.workflowId, versionRef: existing.version.id },
    });
    expect(validateWorkflowIrDocument(candidateParsed.document).ok).toBe(true);
  });

  // -----------------------------------------------------------------------
  // The multi-requirement regression (architect review, PR #146 point 1):
  // an agentic node declaring MULTIPLE API-stable requirements must NEVER be
  // substituted — the deterministic_api spec carries exactly ONE capability,
  // so substitution would silently DROP part of the node's execution
  // contract. Nothing is proposed; no candidate version is ever created.
  // -----------------------------------------------------------------------
  it('the multi-requirement negative: an agentic node with MULTIPLE API-stable requirements yields NO candidate (the capability contract can never shrink)', async () => {
    const { workflowId, version: version1 } = await createWorkflowThroughRoutes(
      'multi-requirement-report',
      'Multi-Requirement Maintenance Report',
      authorMultiRequirementReportDocument(),
    );

    const readRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    const parsed = parseWorkflowIrDocument(JSON.stringify((readRes.json() as { version: VersionPayload }).version.content));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const document = parsed.document;

    // the analysis proposes NOTHING for the multi-requirement node
    const analysis = optimization.analyzeWorkflow(document);
    expect(analysis.opportunities).toEqual([]);
    expect(analysis.rejected).toEqual([]);

    // and proposal creation is typed-rejected (nothing is ever derived)
    let notFound = false;
    try {
      optimization.createProposal({
        ownerId: operatorUserId,
        workflowId,
        versionId: version1.id,
        document,
        opportunityNodeId: 'scan_board',
      });
    } catch (error) {
      notFound = (error as { code?: string }).code === 'OPPORTUNITY_NOT_FOUND';
    }
    expect(notFound).toBe(true);

    // NO candidate version was created (still exactly one version)
    const versionsRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions`,
      headers: { 'x-api-key': operatorKey },
    });
    const versions = (versionsRes.json() as { versions: VersionPayload[] }).versions;
    expect(versions).toHaveLength(1);
    expect(versions[0]!.id).toBe(version1.id);

    // the stored v1 still carries the FULL requirement set, byte-identical
    const storedScan = document.ir.nodes.find((n) => n.id === 'scan_board')!;
    expect(storedScan.capabilityRequirements).toEqual([
      'github.repository.read',
      'spreadsheet.read',
    ]);
  });

  // -----------------------------------------------------------------------
  // The capability-requirements signature regression (architect review,
  // PR #146 point 2): structurally identical agentic nodes with DIFFERENT
  // capability requirements are NOT duplicates — never grouped for reuse.
  // -----------------------------------------------------------------------
  it('the differently-capable duplicates negative: structurally identical agentic nodes with DIFFERENT requirements are NOT grouped for reuse', async () => {
    const { workflowId, version: version1 } = await createWorkflowThroughRoutes(
      'divergent-scans-report',
      'Divergent Scans Maintenance Report',
      authorDifferentlyCapableScansDocument(),
    );

    const readRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    const parsed = parseWorkflowIrDocument(JSON.stringify((readRes.json() as { version: VersionPayload }).version.content));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const document = parsed.document;

    // NO reuse grouping over the differently-capable scans
    const analysis = optimization.analyzeWorkflow(document);
    expect(analysis.opportunities.filter((o) => o.kind === 'workflow_reuse')).toEqual([]);
    expect(analysis.rejected).toEqual([]);

    // both single-requirement scans remain ordinary substitution candidates
    // (canonical serialization order: 'scan_b' sorts before 'scan_board')
    const apiNodes = analysis.opportunities
      .filter((o) => o.kind === 'api_substitution')
      .map((o) => (o.kind === 'api_substitution' ? o.nodeId : ''));
    expect(apiNodes).toEqual(['scan_b', 'scan_board']);

    // a proposal on scan_b resolves the SAFE api_substitution — never a
    // reuse grouping of the two differently-capable nodes
    const proposal = optimization.createProposal({
      ownerId: operatorUserId,
      workflowId,
      versionId: version1.id,
      document,
      opportunityNodeId: 'scan_b',
    });
    expect(proposal.kind).toBe('api_substitution');
    expect(proposal.affectedNodeIds).toEqual(['scan_b']);
    // the substituted candidate carries scan_b's own requirement — verbatim
    const substitutedScan = proposal.candidateDocument.ir.nodes.find(
      (n) => n.id === 'scan_b',
    )!;
    expect(substitutedScan.capabilityRequirements).toEqual(['spreadsheet.read']);
    expect(substitutedScan.spec).toEqual({
      class: 'deterministic_api',
      capability: 'spreadsheet.read',
    });

    // NO candidate version was materialized (still exactly one version)
    const versionsRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions`,
      headers: { 'x-api-key': operatorKey },
    });
    const versions = (versionsRes.json() as { versions: VersionPayload[] }).versions;
    expect(versions).toHaveLength(1);
    expect(versions[0]!.id).toBe(version1.id);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
} from '../../../src/workflow-repository/index.js';
import {
  createWorkflowIrBuilder,
} from '../../../src/workflow-ir/index.js';
import {
  createSequentialIdFactory,
  createSteppingClock,
} from '../../../src/workflow-optimization/index.js';
import type { FastifyInstance } from 'fastify';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

/**
 * V2-017 T11 — the workflow-optimization TRANSPORT routes (the §19/§20
 * surface) over the REAL V2-011 authority + the REAL V2-002 repository.
 *
 * The real paths: the merged V2-002 workflow-repository through its real
 * Fastify routes (app.inject) over a real PGlite database with all
 * migrations — a real authored WorkflowIR workflow with a detectable
 * api_substitution opportunity is created and pinned — and the T11
 * optimization routes:
 *
 *   - analysis (the document resolved SERVER-SIDE from the V2-002 read);
 *   - the proposal lifecycle: create → the owner approval gate →
 *     materialization as a NEW WorkflowVersion through the materializer
 *     port (composed over the REAL repository.createVersion as the
 *     AUTHENTICATED owner — never an activation, never a mutation);
 *   - the deterministic comparison (both documents resolved server-side);
 *   - fail-closed: materialize before approval (409), a non-owner
     decision (403), an unknown version (404).
 */
const OWNER_KEY = 'raw-key-v2-017-t11-opt-owner';
const MEMBER_KEY = 'raw-key-v2-017-t11-opt-member';
const OWNER_ID = 'v2-017-t11-opt-owner';
const MEMBER_ID = 'v2-017-t11-opt-member';

interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
}

/**
 * A real authored workflow with a DETECTABLE optimization opportunity: the
 * `scan_board` agentic_computer_use node declares EXACTLY ONE API-stable
 * non-UI-automation capability (github.repository.read) — the rules-v1
 * api_substitution opportunity (safe: not sensitive, not human).
 */
function authorOptimizableWorkflow(seed: string): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addNode({
      id: 'fetch_tickets',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        {
          name: 'repository',
          type: { kind: 'string' },
          binding: { kind: 'literal', value: `pectoraux/WorkflowOS#${seed}` },
        },
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
        {
          name: 'tickets',
          type: { kind: 'json' },
          binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' },
        },
      ],
      outputs: [
        { name: 'digest', type: { kind: 'string' } },
        { name: 'openCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_allowed',
      inputs: [
        {
          name: 'text',
          type: { kind: 'string' },
          binding: { kind: 'node_output', node: 'scan_board', output: 'digest' },
        },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addEdge({ from: 'fetch_tickets', to: 'scan_board', on: 'success' })
    .addEdge({ from: 'scan_board', to: 'send_digest', on: 'success' })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .build();
}

/** Serialize the IR document the way the V2-002 routes accept it. */
function bodyOf(document: WorkflowIrDocument): Record<string, unknown> {
  return {
    content: JSON.parse(JSON.stringify(document)) as Record<string, unknown>,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  };
}

describe('V2-017 T11 — the optimization transport routes over the real authorities', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgId: string;
  let ownerKey: string;
  let memberKey: string;
  let workflowId: string;
  let version1: VersionPayload;
  let version2: VersionPayload;
  let installationId: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_V2_017_T11_OWNER: OWNER_KEY,
      WFOS_TEST_KEY_V2_017_T11_MEMBER: MEMBER_KEY,
    });
    const org = await stack.organizationRepository.create({ name: 'T11 Optimization Route Org' });
    const owner = await stack.userRepository.upsertByExternalId({
      externalId: OWNER_ID,
      displayName: 'T11 Owner',
    });
    const member = await stack.userRepository.upsertByExternalId({
      externalId: MEMBER_ID,
      displayName: 'T11 Member',
    });
    await stack.membershipRepository.assign({ userId: owner.id, organizationId: org.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: member.id, organizationId: org.id, roleId: 'member' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-017-t11-owner-key', secretRef: 'WFOS_TEST_KEY_V2_017_T11_OWNER', externalId: OWNER_ID,
      label: 'T11 Owner', rawKey: OWNER_KEY,
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-017-t11-member-key', secretRef: 'WFOS_TEST_KEY_V2_017_T11_MEMBER', externalId: MEMBER_ID,
      label: 'T11 Member', rawKey: MEMBER_KEY,
    });
    orgId = org.id;
    ownerKey = OWNER_KEY;
    memberKey = MEMBER_KEY;

    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    const repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });
    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      workflowRepository: { workflowRepositoryService: repository },
      workflowOptimization: {
        workflowRepositoryService: repository,
        idFactory: createSequentialIdFactory('opt'),
        clock: createSteppingClock(1789000000000, 1000),
      },
    });
    await server.ready();

    // --- author the fixtures through the real V2-002 routes ----------------
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgId}/workflow-repository/workflows`,
      headers: { 'x-api-key': ownerKey },
      payload: {
        slug: 't11-optimizable-digest',
        name: 'T11 Optimizable Digest',
        description: 'Fetch, scan, send — with a detectable improvement',
        visibility: 'private',
        ...bodyOf(authorOptimizableWorkflow('v1')),
      },
    });
    expect(createRes.statusCode, createRes.body).toBe(201);
    const created = createRes.json() as { workflow: { id: string }; initialVersion: VersionPayload };
    workflowId = created.workflow.id;
    version1 = created.initialVersion;

    // version 2: a content change (the §19 update material).
    const v2Res = await server.inject({
      method: 'POST',
      url: `/workflow-repository/workflows/${workflowId}/versions`,
      headers: { 'x-api-key': ownerKey },
      payload: { ...bodyOf(authorOptimizableWorkflow('v2')), parentVersionId: version1.id },
    });
    expect(v2Res.statusCode, v2Res.body).toBe(201);
    version2 = (v2Res.json() as { version: VersionPayload }).version;

    // install version 1 (the immutable pin).
    const installRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgId}/workflow-repository/installations`,
      headers: { 'x-api-key': ownerKey },
      payload: { workflowId, versionId: version1.id },
    });
    expect(installRes.statusCode, installRes.body).toBe(201);
    installationId = (installRes.json() as { installation: { id: string } }).installation.id;
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  it('analyze resolves the document SERVER-SIDE and returns the detectable opportunity', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/workflow-optimization/analyze',
      headers: { 'x-api-key': ownerKey },
      payload: { workflowId, versionId: version1.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      analysis: {
        analysisId: string;
        rulesVersion: string;
        opportunities: Array<{ kind: string; nodeId: string; apiCapability: string }>;
        rejected: unknown[];
      };
    };
    expect(body.analysis.rulesVersion).toBe('workflowos-optimization-rules-v1');
    expect(body.analysis.analysisId).toMatch(/^opt_[0-9a-f]{16,}$/);
    expect(body.analysis.opportunities).toHaveLength(1);
    expect(body.analysis.opportunities[0]!.kind).toBe('api_substitution');
    expect(body.analysis.opportunities[0]!.nodeId).toBe('scan_board');
    expect(body.analysis.opportunities[0]!.apiCapability).toBe('github.repository.read');
    // the embedded document is NOT carried on the wire (the client already
    // holds the version content; the route resolved it server-side).
    expect((body.analysis as Record<string, unknown>).document).toBeUndefined();
  });

  it('analyze with an unknown version fails closed (404, honest unavailable)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/workflow-optimization/analyze',
      headers: { 'x-api-key': ownerKey },
      payload: { workflowId, versionId: 'wfwv_does_not_exist' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('the full §20 gate: create → approve → materialize as a NEW version; the pin and baseline never move', async () => {
    // --- create the proposal (owner; document resolved server-side) --------
    const createRes = await server.inject({
      method: 'POST',
      url: '/workflow-optimization/proposals',
      headers: { 'x-api-key': ownerKey },
      payload: { workflowId, versionId: version1.id, opportunityNodeId: 'scan_board' },
    });
    expect(createRes.statusCode, createRes.body).toBe(201);
    const created = (createRes.json() as { proposal: Record<string, unknown> }).proposal;
    const proposalId = created.id as string;
    expect(created.status).toBe('proposed');
    expect(created.ownerId).toBe(OWNER_ID);
    const comparison = created.comparison as { correctness: { equivalent: boolean } };
    expect(comparison.correctness.equivalent).toBe(true);
    // the embedded documents are NOT carried on the wire.
    expect(created.baselineDocument).toBeUndefined();
    expect(created.candidateDocument).toBeUndefined();

    // --- the fail-closed gate: materialize BEFORE approval -----------------
    const early = await server.inject({
      method: 'POST',
      url: `/workflow-optimization/proposals/${proposalId}/materialize`,
      headers: { 'x-api-key': ownerKey },
      payload: {},
    });
    expect(early.statusCode).toBe(409);
    expect((early.json() as { code: string }).code).toBe('APPROVAL_REQUIRED');

    // --- a non-owner (org member) may not approve --------------------------
    const nonOwner = await server.inject({
      method: 'POST',
      url: `/workflow-optimization/proposals/${proposalId}/approve`,
      headers: { 'x-api-key': memberKey },
      payload: {},
    });
    expect(nonOwner.statusCode).toBe(403);
    expect((nonOwner.json() as { code: string }).code).toBe('OWNER_MISMATCH');

    // --- the owner approves --------------------------------------------------
    const approveRes = await server.inject({
      method: 'POST',
      url: `/workflow-optimization/proposals/${proposalId}/approve`,
      headers: { 'x-api-key': ownerKey },
      payload: {},
    });
    expect(approveRes.statusCode, approveRes.body).toBe(200);
    const approved = (approveRes.json() as { proposal: Record<string, unknown> }).proposal;
    expect(approved.status).toBe('approved');

    // --- materialize: a REAL new version through V2-002 ---------------------
    const materializeRes = await server.inject({
      method: 'POST',
      url: `/workflow-optimization/proposals/${proposalId}/materialize`,
      headers: { 'x-api-key': ownerKey },
      payload: {},
    });
    expect(materializeRes.statusCode, materializeRes.body).toBe(200);
    const body = materializeRes.json() as {
      proposal: { status: string };
      materialization: { workflowId: string; versionId: string };
    };
    expect(body.proposal.status).toBe('materialized');
    expect(body.materialization.workflowId).toBe(workflowId);
    const candidateVersionId = body.materialization.versionId;
    expect(candidateVersionId).not.toBe(version1.id);

    // the candidate is a REAL WorkflowVersion (parent = the baseline, v3 of 3).
    const versionsRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions`,
      headers: { 'x-api-key': ownerKey },
    });
    expect(versionsRes.statusCode).toBe(200);
    const versions = (versionsRes.json() as { versions: VersionPayload[] }).versions;
    expect(versions.map((v) => v.id)).toContain(candidateVersionId);
    const candidate = versions.find((v) => v.id === candidateVersionId)!;
    expect(candidate.versionNumber).toBe(3);
    expect(candidate.parentVersionId).toBe(version1.id);

    // the installation STILL pins version 1 (materialization never activates).
    const installationRes = await server.inject({
      method: 'GET',
      url: `/organizations/${orgId}/workflow-repository/installations/${installationId}`,
      headers: { 'x-api-key': ownerKey },
    });
    expect(installationRes.statusCode).toBe(200);
    const installation = (installationRes.json() as { installation: { versionId: string } }).installation;
    expect(installation.versionId).toBe(version1.id);

    // version 1 is byte-identical (no mutation, ever).
    const v1Read = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': ownerKey },
    });
    expect(v1Read.statusCode).toBe(200);
    const v1Body = v1Read.json() as { version: VersionPayload };
    expect(v1Body.version.id).toBe(version1.id);
    expect(v1Body.version.contentDigest).toBe(version1.contentDigest);
  });

  it('the deterministic comparison: both documents resolved server-side; unknown versions fail closed', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/workflow-optimization/compare',
      headers: { 'x-api-key': ownerKey },
      payload: { workflowId, baselineVersionId: version1.id, candidateVersionId: version2.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      comparison: {
        correctness: { equivalent: boolean; firstDivergence: string | null };
        negotiation: { decision: string };
        latency: { baseline: number; candidate: number; delta: number };
      };
    };
    expect(body.comparison.rulesVersion ?? body.comparison).toBeDefined();
    expect(typeof body.comparison.correctness.equivalent).toBe('boolean');
    expect(typeof body.comparison.latency.delta).toBe('number');

    // fail closed: an unknown baseline version.
    const bad = await server.inject({
      method: 'POST',
      url: '/workflow-optimization/compare',
      headers: { 'x-api-key': ownerKey },
      payload: { workflowId, baselineVersionId: 'wfwv_nope', candidateVersionId: version2.id },
    });
    expect(bad.statusCode).toBe(404);
  });

  it('proposal decisions are single-shot (the typed rejections)', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/workflow-optimization/proposals',
      headers: { 'x-api-key': ownerKey },
      payload: { workflowId, versionId: version1.id, opportunityNodeId: 'scan_board' },
    });
    expect(createRes.statusCode, createRes.body).toBe(201);
    const proposalId = (createRes.json() as { proposal: { id: string } }).proposal.id;

    const first = await server.inject({
      method: 'POST',
      url: `/workflow-optimization/proposals/${proposalId}/reject`,
      headers: { 'x-api-key': ownerKey },
      payload: { note: 'not now' },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as { proposal: { status: string } }).proposal.status).toBe('rejected');

    // rejected is TERMINAL: approve afterwards is the typed already-decided.
    const second = await server.inject({
      method: 'POST',
      url: `/workflow-optimization/proposals/${proposalId}/approve`,
      headers: { 'x-api-key': ownerKey },
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe('PROPOSAL_ALREADY_DECIDED');

    // an unknown proposal id is 404.
    const missing = await server.inject({
      method: 'POST',
      url: '/workflow-optimization/proposals/opt_nope/approve',
      headers: { 'x-api-key': ownerKey },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });

  it('listProposals scopes by workflow (the converge read)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/workflow-optimization/proposals?workflowId=${workflowId}`,
      headers: { 'x-api-key': ownerKey },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { proposals: Array<{ id: string; status: string }> };
    // the two proposals created above (materialized + rejected).
    expect(body.proposals.length).toBeGreaterThanOrEqual(2);
    for (const p of body.proposals) {
      expect(p.id).toMatch(/^opt_/);
    }
  });
});

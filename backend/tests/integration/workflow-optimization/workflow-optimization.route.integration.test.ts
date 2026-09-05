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
/** The SECOND fully-independent owner (own org, own workflow) for the
 * concurrency regression: their key provisions in the test body. */
const OWNER2_KEY = 'raw-key-v2-017-t11-opt-owner2';
const OWNER2_ID = 'v2-017-t11-opt-owner2';
/** A fully-independent OUTSIDER (own org, NOT a member of the workflow's
 * org) for the F01 authorization regression: provisions in the test body. */
const OUTSIDER_KEY = 'raw-key-v2-017-t11-opt-outsider';
const OUTSIDER_ID = 'v2-017-t11-opt-outsider';

interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
  parentVersionId: string | null;
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
  let ownerUserId: string;
  let workflowId: string;
  let version1: VersionPayload;
  let version2: VersionPayload;
  let installationId: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_V2_017_T11_OWNER: OWNER_KEY,
      WFOS_TEST_KEY_V2_017_T11_MEMBER: MEMBER_KEY,
      WFOS_TEST_KEY_V2_017_T11_OWNER2: OWNER2_KEY,
      WFOS_TEST_KEY_V2_017_T11_OUTSIDER: OUTSIDER_KEY,
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
    ownerUserId = owner.id;

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
    expect(created.ownerId).toBe(ownerUserId);
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
        rulesVersion: string;
        correctness: { equivalent: boolean; firstDivergence: string | null };
        negotiation: { decision: string };
        latency: { baseline: number; candidate: number; delta: number };
      };
    };
    expect(body.comparison.rulesVersion).toBe('workflowos-optimization-rules-v1');
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

  it('GET proposals authorizes the workflow through the canonical V2-002 gate (architect finding T11-F01)', async () => {
    // A fully-independent outsider (own org, NOT a member of the workflow's
    // org) cannot enumerate another workflow's proposals: the V2-002
    // visibility/ownership gate fails closed BEFORE the proposal store is
    // read — never the proposal rows.
    const outsiderOrg = await stack.organizationRepository.create({
      name: 'T11 Optimization Outsider Org',
    });
    const outsider = await stack.userRepository.upsertByExternalId({
      externalId: OUTSIDER_ID,
      displayName: 'T11 Outsider',
    });
    await stack.membershipRepository.assign({
      userId: outsider.id,
      organizationId: outsiderOrg.id,
      roleId: 'owner',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-017-t11-outsider-key',
      secretRef: 'WFOS_TEST_KEY_V2_017_T11_OUTSIDER',
      externalId: OUTSIDER_ID,
      label: 'T11 Outsider',
      rawKey: OUTSIDER_KEY,
    });

    const denied = await server.inject({
      method: 'GET',
      url: `/workflow-optimization/proposals?workflowId=${workflowId}`,
      headers: { 'x-api-key': OUTSIDER_KEY },
    });
    expect(denied.statusCode, denied.body).toBe(404);
    const deniedBody = denied.json() as { error: string; proposals?: unknown };
    expect(deniedBody.error).toBe('workflow-optimization-workflow-not-found');
    // no proposal state leaks through the denial.
    expect(deniedBody.proposals).toBeUndefined();

    // The denial is INDISTINGUISHABLE from an unknown workflow (the V2-002
    // convention — no existence leak).
    const unknown = await server.inject({
      method: 'GET',
      url: '/workflow-optimization/proposals?workflowId=wf_does_not_exist',
      headers: { 'x-api-key': ownerKey },
    });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: string }).error).toBe(
      'workflow-optimization-workflow-not-found',
    );

    // An unscoped listing is rejected fail-closed: there is no workflow to
    // authorize the read against, so it must not enumerate proposal state
    // across workflows.
    const unscoped = await server.inject({
      method: 'GET',
      url: '/workflow-optimization/proposals',
      headers: { 'x-api-key': ownerKey },
    });
    expect(unscoped.statusCode).toBe(400);

    // The gate is V2-002's OWN visibility decision — neither broader nor an
    // owner-only re-invention: this fixture workflow is PRIVATE (owner-only
    // reads in V2-002), so a same-org MEMBER is denied exactly as V2-002
    // denies them …
    const memberRes = await server.inject({
      method: 'GET',
      url: `/workflow-optimization/proposals?workflowId=${workflowId}`,
      headers: { 'x-api-key': memberKey },
    });
    expect(memberRes.statusCode, memberRes.body).toBe(404);
    expect((memberRes.json() as { error: string }).error).toBe(
      'workflow-optimization-workflow-not-found',
    );

    // … while the authorized OWNER still reads the converge list.
    const ownerRes = await server.inject({
      method: 'GET',
      url: `/workflow-optimization/proposals?workflowId=${workflowId}`,
      headers: { 'x-api-key': ownerKey },
    });
    expect(ownerRes.statusCode, ownerRes.body).toBe(200);
    expect(
      (ownerRes.json() as { proposals: unknown[] }).proposals.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("CONCURRENCY REGRESSION (the PR #203 architect gate): two simultaneous materializations remain owner-isolated — a request's authenticated principal can never create a version under the other request's identity", async () => {
    // A SECOND fully-independent owner in a SECOND organization with their
    // OWN workflow. V2-002 createVersion is WORKFLOW-OWNER-ONLY (fail-closed
    // WORKFLOW_NOT_OWNED / not-visible), so if request A's materializer ever
    // ran under request B's principal, A's materialization would fail closed
    // (502 MATERIALIZER_FAILED) instead of silently succeeding — the leak is
    // observable, never silent, and this regression fails loudly either way.
    const org2 = await stack.organizationRepository.create({
      name: 'T11 Optimization Concurrency Org B',
    });
    const owner2 = await stack.userRepository.upsertByExternalId({
      externalId: OWNER2_ID,
      displayName: 'T11 Owner B',
    });
    await stack.membershipRepository.assign({
      userId: owner2.id,
      organizationId: org2.id,
      roleId: 'owner',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-017-t11-owner2-key',
      secretRef: 'WFOS_TEST_KEY_V2_017_T11_OWNER2',
      externalId: OWNER2_ID,
      label: 'T11 Owner B',
      rawKey: OWNER2_KEY,
    });

    const wf2Res = await server.inject({
      method: 'POST',
      url: `/organizations/${org2.id}/workflow-repository/workflows`,
      headers: { 'x-api-key': OWNER2_KEY },
      payload: {
        slug: 't11-concurrent-b',
        name: 'T11 Concurrent B',
        description: 'The second owner’s own optimizable workflow',
        visibility: 'private',
        ...bodyOf(authorOptimizableWorkflow('concurrent-b')),
      },
    });
    expect(wf2Res.statusCode, wf2Res.body).toBe(201);
    const wf2Created = wf2Res.json() as {
      workflow: { id: string };
      initialVersion: VersionPayload;
    };
    const workflow2Id = wf2Created.workflow.id;
    const workflow2V1 = wf2Created.initialVersion;

    // One APPROVED proposal per owner, each pinned to their OWN workflow's
    // baseline (the materializer composes V2-002 createVersion as the
    // AUTHENTICATED owner of exactly that workflow).
    const createApprovedProposal = async (
      key: string,
      wfId: string,
      versionId: string,
    ): Promise<string> => {
      const create = await server.inject({
        method: 'POST',
        url: '/workflow-optimization/proposals',
        headers: { 'x-api-key': key },
        payload: { workflowId: wfId, versionId, opportunityNodeId: 'scan_board' },
      });
      expect(create.statusCode, create.body).toBe(201);
      const proposalId = (create.json() as { proposal: { id: string } }).proposal.id;
      const approve = await server.inject({
        method: 'POST',
        url: `/workflow-optimization/proposals/${proposalId}/approve`,
        headers: { 'x-api-key': key },
        payload: {},
      });
      expect(approve.statusCode, approve.body).toBe(200);
      return proposalId;
    };

    const proposalA = await createApprovedProposal(ownerKey, workflowId, version1.id);
    const proposalB = await createApprovedProposal(OWNER2_KEY, workflow2Id, workflow2V1.id);

    // --- TWO SIMULTANEOUS materializations with REAL I/O interleaving ------
    // A is dispatched first and driven into its createVersion PGlite I/O by
    // a macrotask ladder; B is dispatched while A is still in flight, so the
    // two requests genuinely overlap against the same route instance.
    const inFlightA = server.inject({
      method: 'POST',
      url: `/workflow-optimization/proposals/${proposalA}/materialize`,
      headers: { 'x-api-key': ownerKey },
      payload: {},
    });
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const inFlightB = server.inject({
      method: 'POST',
      url: `/workflow-optimization/proposals/${proposalB}/materialize`,
      headers: { 'x-api-key': OWNER2_KEY },
      payload: {},
    });
    const [resA, resB] = await Promise.all([inFlightA, inFlightB]);

    // BOTH requests succeed — under a shared mutable principal a leak would
    // fail one of them closed (502) or create under the wrong identity.
    expect(resA.statusCode, resA.body).toBe(200);
    expect(resB.statusCode, resB.body).toBe(200);
    const bodyA = resA.json() as {
      proposal: { status: string };
      materialization: { workflowId: string; versionId: string };
    };
    const bodyB = resB.json() as {
      proposal: { status: string };
      materialization: { workflowId: string; versionId: string };
    };
    expect(bodyA.proposal.status).toBe('materialized');
    expect(bodyB.proposal.status).toBe('materialized');
    // each materialization belongs to ITS OWN workflow — never the other's.
    expect(bodyA.materialization.workflowId).toBe(workflowId);
    expect(bodyB.materialization.workflowId).toBe(workflow2Id);
    const candidateA = bodyA.materialization.versionId;
    const candidateB = bodyB.materialization.versionId;
    expect(candidateA).not.toBe(candidateB);

    // Each candidate is a REAL WorkflowVersion of ITS OWN workflow, parented
    // by its own baseline — and NO cross-creation happened.
    const versionsA = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions`,
      headers: { 'x-api-key': ownerKey },
    });
    const versionsB = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflow2Id}/versions`,
      headers: { 'x-api-key': OWNER2_KEY },
    });
    expect(versionsA.statusCode, versionsA.body).toBe(200);
    expect(versionsB.statusCode, versionsB.body).toBe(200);
    const listA = (versionsA.json() as { versions: VersionPayload[] }).versions;
    const listB = (versionsB.json() as { versions: VersionPayload[] }).versions;
    const candidateVersionA = listA.find((v) => v.id === candidateA)!;
    const candidateVersionB = listB.find((v) => v.id === candidateB)!;
    expect(candidateVersionA.parentVersionId).toBe(version1.id);
    expect(candidateVersionB.parentVersionId).toBe(workflow2V1.id);
    expect(listA.map((v) => v.id)).not.toContain(candidateB);
    expect(listB.map((v) => v.id)).not.toContain(candidateA);

    // Cross-owner reads fail closed: each candidate version is visible ONLY
    // to its own workflow's visibility chain (a version created under the
    // wrong request's identity would surface here as a cross-visible row).
    const crossReadByB = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${candidateA}`,
      headers: { 'x-api-key': OWNER2_KEY },
    });
    const crossReadByA = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflow2Id}/versions/${candidateB}`,
      headers: { 'x-api-key': ownerKey },
    });
    expect(crossReadByB.statusCode).toBe(404);
    expect(crossReadByA.statusCode).toBe(404);
  });
});

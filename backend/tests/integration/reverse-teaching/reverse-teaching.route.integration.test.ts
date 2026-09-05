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
  DefaultReverseTeachingSessionService,
  InMemoryReverseTeachingSessionStore,
  createSequentialIdFactory,
  createSteppingClock,
} from '../../../src/reverse-teaching/index.js';
import type { FastifyInstance } from 'fastify';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

/**
 * V2-017 T9 (architect gate correction) — the reverse-teaching TRANSPORT
 * routes enforce the V2-002 installation pin authority.
 *
 * The real paths: the merged V2-002 workflow-repository through its real
 * Fastify routes (app.inject) over a real PGlite database with all
 * migrations — a real authored WorkflowIR workflow is installed and pinned —
 * and the T9 reverse-teaching routes over the real V2-010 authority.
 *
 * The regression the architect demanded: a mismatched
 * installation/workflow/version tuple FAILS CLOSED. A valid installation id
 * can never be paired with another visible workflow or version (the
 * run-service RUN_INSTALLATION_MISMATCH precedent, at the transport): the
 * tuple is DERIVED from the authoritative `getInstallation` read and the
 * digest is computed from that authoritative pinned version — never from
 * client-supplied identifiers.
 */
const OPERATOR_KEY = 'raw-key-v2-017-t9-rt-route';
const LEARNER_ID = 'v2-017-t9-rt-route-learner';

interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
}

interface ReverseSessionPayload {
  session: {
    id: string;
    pin: {
      workflowId: string;
      versionId: string;
      installationId: string;
      semanticDigest: { algorithm: string; domain: string; digest: string };
    };
    status: string;
    lesson: { stepOrder: string[] } | null;
  };
  created: boolean;
}

/** A small real authored workflow (fetch → do → send), parameterized so
 * distinct authorings yield distinct semantic digests. */
function authorDigestWorkflow(seed: string, task: string): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_step')
    .addNode({
      id: 'fetch_step',
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
      outputs: [{ name: 'report', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'do_step',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task },
      capabilityRequirements: [],
      placement: 'cloud_allowed',
      inputs: [
        {
          name: 'report',
          type: { kind: 'string' },
          binding: { kind: 'node_output', node: 'fetch_step', output: 'report' },
        },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'send_step',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_allowed',
      inputs: [
        {
          name: 'text',
          type: { kind: 'string' },
          binding: { kind: 'node_output', node: 'do_step', output: 'tickets' },
        },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addEdge({ from: 'fetch_step', to: 'do_step', on: 'success' })
    .addEdge({ from: 'do_step', to: 'send_step', on: 'success' })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_step', output: 'messageId' },
    })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .build();
}

/** Create a real workflow through the real V2-002 routes; returns ids. */
async function createWorkflow(
  server: FastifyInstance,
  orgId: string,
  key: string,
  slug: string,
  document: WorkflowIrDocument,
): Promise<{ workflowId: string; initialVersion: VersionPayload }> {
  const res = await server.inject({
    method: 'POST',
    url: `/organizations/${orgId}/workflow-repository/workflows`,
    headers: { 'x-api-key': key },
    payload: {
      slug,
      name: slug,
      description: `the ${slug} regression fixture`,
      visibility: 'private',
      content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const created = res.json() as { workflow: { id: string }; initialVersion: VersionPayload };
  return { workflowId: created.workflow.id, initialVersion: created.initialVersion };
}

describe('V2-017 T9 — the reverse-teaching routes enforce the installation pin authority (fail closed)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgA: string;
  let orgB: string;
  let key: string;

  // workflow A version 1 is the INSTALLED pin; version 2 and workflow B are
  // the mismatch material (both perfectly visible to the learner).
  let workflowA: string;
  let versionA1: VersionPayload;
  let versionA2: VersionPayload;
  let workflowB: string;
  let versionB: VersionPayload;
  let installationId: string;
  let installedDigest: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_V2_017_RT: OPERATOR_KEY,
    });
    const orgARecord = await stack.organizationRepository.create({ name: 'T9 Route Org A' });
    const orgBRecord = await stack.organizationRepository.create({ name: 'T9 Route Org B' });
    const learner = await stack.userRepository.upsertByExternalId({
      externalId: LEARNER_ID,
      displayName: 'T9 Route Learner',
    });
    // the learner is a member of BOTH organizations — the cross-org pairing
    // below is therefore an authorization-valid, tuple-invalid attempt.
    await stack.membershipRepository.assign({
      userId: learner.id, organizationId: orgARecord.id, roleId: 'owner',
    });
    await stack.membershipRepository.assign({
      userId: learner.id, organizationId: orgBRecord.id, roleId: 'owner',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-017-rt-key', secretRef: 'WFOS_TEST_KEY_V2_017_RT', externalId: LEARNER_ID,
      label: 'V2-017 RT', rawKey: OPERATOR_KEY,
    });
    orgA = orgARecord.id;
    orgB = orgBRecord.id;
    key = OPERATOR_KEY;

    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    const repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });
    const reverseTeachingService = new DefaultReverseTeachingSessionService({
      idFactory: createSequentialIdFactory('rt'),
      clock: createSteppingClock(1733568000000, 1000),
      store: new InMemoryReverseTeachingSessionStore(),
    });
    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      workflowRepository: { workflowRepositoryService: repository },
      reverseTeaching: {
        reverseTeachingService,
        workflowRepositoryService: repository,
      },
    });
    await server.ready();

    // --- author the fixtures through the real V2-002 routes ----------------
    const a = await createWorkflow(
      server, orgA, key, 't9-route-digest-a-v1', authorDigestWorkflow('a1', 'Copy the open ticket numbers'),
    );
    workflowA = a.workflowId;
    versionA1 = a.initialVersion;

    const v2Res = await server.inject({
      method: 'POST',
      url: `/workflow-repository/workflows/${workflowA}/versions`,
      headers: { 'x-api-key': key },
      payload: {
        content: JSON.parse(
          serializeWorkflowIrDocument(authorDigestWorkflow('a2', 'Copy the CLOSED ticket numbers')),
        ) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        parentVersionId: versionA1.id,
      },
    });
    expect(v2Res.statusCode, v2Res.body).toBe(201);
    versionA2 = (v2Res.json() as { version: VersionPayload }).version;

    const b = await createWorkflow(
      server, orgA, key, 't9-route-digest-b', authorDigestWorkflow('b1', 'Draft the weekly status update'),
    );
    workflowB = b.workflowId;
    versionB = b.initialVersion;

    // --- INSTALL workflow A version 1 (the immutable pin) -------------------
    const installRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgA}/workflow-repository/installations`,
      headers: { 'x-api-key': key },
      payload: { workflowId: workflowA, versionId: versionA1.id },
    });
    expect(installRes.statusCode, installRes.body).toBe(201);
    installationId = (installRes.json() as { installation: { id: string } }).installation.id;

    // the authoritative digest of the INSTALLED version (computed server-side
    // by the transport from the installation's pinned version — the value the
    // created session's pin must carry).
    const parsed = parseWorkflowIrDocument(JSON.stringify(versionA1.content));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    installedDigest = computeWorkflowVersionSemanticDigest(parsed.document).digest;
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  it('the mismatch regressions fail CLOSED — no session ever leaks from a rejected tuple', async () => {
    // --- the attack: a valid installation paired with ANOTHER VERSION of
    // the same workflow (perfectly visible, never installed) — REJECTED.
    const wrongVersion = await server.inject({
      method: 'POST',
      url: '/reverse-teaching/sessions',
      headers: { 'x-api-key': key },
      payload: {
        organizationId: orgA,
        workflowId: workflowA,
        versionId: versionA2.id,
        installationId,
      },
    });
    expect(wrongVersion.statusCode).toBe(400);
    const wrongVersionBody = wrongVersion.json() as { error: string; code: string };
    expect(wrongVersionBody.error).toBe('reverse-teaching-installation-pin-invalid');
    expect(wrongVersionBody.code).toBe('INSTALLATION_PIN_INVALID');

    // --- the attack: a valid installation paired with ANOTHER WORKFLOW —
    // REJECTED with the same typed code.
    const wrongWorkflow = await server.inject({
      method: 'POST',
      url: '/reverse-teaching/sessions',
      headers: { 'x-api-key': key },
      payload: {
        organizationId: orgA,
        workflowId: workflowB,
        versionId: versionB.id,
        installationId,
      },
    });
    expect(wrongWorkflow.statusCode).toBe(400);
    const wrongWorkflowBody = wrongWorkflow.json() as { error: string; code: string };
    expect(wrongWorkflowBody.error).toBe('reverse-teaching-installation-pin-invalid');
    expect(wrongWorkflowBody.code).toBe('INSTALLATION_PIN_INVALID');

    // --- the attack: the installation paired with ANOTHER ORGANIZATION the
    // learner legitimately belongs to — the installation does not exist
    // there, so the tuple cannot resolve — REJECTED (fail closed, 404).
    const wrongOrg = await server.inject({
      method: 'POST',
      url: '/reverse-teaching/sessions',
      headers: { 'x-api-key': key },
      payload: {
        organizationId: orgB,
        workflowId: workflowA,
        versionId: versionA1.id,
        installationId,
      },
    });
    expect(wrongOrg.statusCode).toBe(404);

    // --- nothing leaked: the FIRST correct create still says created:true
    // (none of the rejected attempts left a session behind).
    const correct = await server.inject({
      method: 'POST',
      url: '/reverse-teaching/sessions',
      headers: { 'x-api-key': key },
      payload: {
        organizationId: orgA,
        workflowId: workflowA,
        versionId: versionA1.id,
        installationId,
      },
    });
    expect(correct.statusCode, correct.body).toBe(201);
    const created = correct.json() as ReverseSessionPayload;
    expect(created.created).toBe(true);
  });

  it('the created session pins the INSTALLATION-authoritative tuple and digest; begin-lesson derives from it', async () => {
    const converge = await server.inject({
      method: 'POST',
      url: '/reverse-teaching/sessions',
      headers: { 'x-api-key': key },
      payload: {
        organizationId: orgA,
        workflowId: workflowA,
        versionId: versionA1.id,
        installationId,
      },
    });
    expect(converge.statusCode, converge.body).toBe(200);
    const converged = converge.json() as ReverseSessionPayload;
    expect(converged.created).toBe(false);

    // the pin is the INSTALLATION's authoritative tuple — not client data.
    expect(converged.session.pin.workflowId).toBe(workflowA);
    expect(converged.session.pin.versionId).toBe(versionA1.id);
    expect(converged.session.pin.installationId).toBe(installationId);
    // the digest is the authoritative pinned version's (sha-256, the V2-003 domain).
    expect(converged.session.pin.semanticDigest.digest).toBe(installedDigest);
    expect(converged.session.pin.semanticDigest.algorithm).toBe('sha-256');
    expect(converged.session.pin.semanticDigest.domain).toBe('workflowos/workflow-ir/v1');

    // the session id from the converge read drives begin-lesson: the route
    // re-reads the authoritative pinned version and the V2-010 authority
    // verifies the document against the pin digest.
    const begin = await server.inject({
      method: 'POST',
      url: `/reverse-teaching/sessions/${converged.session.id}/begin-lesson`,
      headers: { 'x-api-key': key },
      payload: {},
    });
    expect(begin.statusCode, begin.body).toBe(200);
    const begun = (begin.json() as { session: ReverseSessionPayload['session'] }).session;
    expect(begun.status).toBe('in_progress');
    // the manual-task view of the installed version (the authority's derivation).
    expect(begun.lesson!.stepOrder).toEqual(['fetch_step', 'do_step', 'send_step']);
  });
});

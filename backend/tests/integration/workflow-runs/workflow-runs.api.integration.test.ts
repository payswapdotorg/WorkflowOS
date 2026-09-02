/**
 * V2-005 — the HTTP route surface over the REAL Fastify buildServer with the
 * real auth plugin + the V2-002 workflow-repository routes and the new V2-005
 * run routes, driven over HTTP via app.inject() (the V2-002/V2-006 harness
 * pattern). The route layer is transport only — the module is the authority.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import { buildServer } from '@api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore } from '@platform/index.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
} from '../../../src/workflow-repository/index.js';
import {
  DefaultWorkflowRunService,
  createSteppingRunClock,
} from '../../../src/workflow-runs/index.js';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { commitmentOf, triageVersionContent } from './run-test-support.js';

const OPERATOR_KEY = 'v2-005-api-test-operator-key';
const OUTSIDER_KEY = 'v2-005-api-test-outsider-key';

describe('V2-005 — run command + history HTTP surface (real Fastify, app.inject)', () => {
  let stack: TestAuthStack;
  let app: FastifyInstance;
  let workflowId: string;
  let versionId: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_V2_005_API_TEST_OPERATOR_KEY: OPERATOR_KEY,
      WFOS_V2_005_API_TEST_OUTSIDER_KEY: OUTSIDER_KEY,
    });
    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    const repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });
    const runService = new DefaultWorkflowRunService({
      db: stack.db.client,
      memberships,
      workflowRepository: repository,
      clock: createSteppingRunClock(1788264000000, 1000),
      currentEpoch: 7,
    });

    const org = await stack.organizationRepository.create({ name: 'V2-005 API Org' });
    const operator = await stack.userRepository.upsertByExternalId({
      externalId: 'v2-005-api-operator',
      displayName: 'V2-005 API Operator',
    });
    const outsider = await stack.userRepository.upsertByExternalId({
      externalId: 'v2-005-api-outsider',
      displayName: 'V2-005 API Outsider',
    });
    const outsiderOrg = await stack.organizationRepository.create({ name: 'V2-005 API Outsider Org' });
    await stack.membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: outsider.id, organizationId: outsiderOrg.id, roleId: 'owner' });
    const provisioner = new ApiKeyCredentialProvisioner(stack.db.client);
    await provisioner.provision({
      keyId: 'v2-005-api-operator-key',
      secretRef: 'WFOS_V2_005_API_TEST_OPERATOR_KEY',
      externalId: 'v2-005-api-operator',
      label: 'V2-005 API Operator',
      rawKey: OPERATOR_KEY,
    });
    await provisioner.provision({
      keyId: 'v2-005-api-outsider-key',
      secretRef: 'WFOS_V2_005_API_TEST_OUTSIDER_KEY',
      externalId: 'v2-005-api-outsider',
      label: 'V2-005 API Outsider',
      rawKey: OUTSIDER_KEY,
    });

    const authProvider = new ApiKeyAuthProvider(stack.db.client, new EnvSecretStore());
    app = await buildServer({
      queue: new InMemoryQueue(),
      logger: createLogger({ level: 'info' }),
      auth: { authProvider, userRepository: stack.userRepository },
      workflowRepository: { workflowRepositoryService: repository },
      workflowRuns: { workflowRunService: runService },
    });
    await app.ready();

    // a real WorkflowIR workflow + version 1 through the REAL repository route
    const createRes = await inject('POST', `/organizations/${org.id}/workflow-repository/workflows`, {
      slug: 'api-triage',
      name: 'API Triage',
      description: null,
      visibility: 'private',
      content: triageVersionContent(),
      protocol: { irSchemaVersion: 'test-ir-1' },
    }, OPERATOR_KEY);
    const created = createRes.json() as {
      workflow: { id: string; headVersionId: string };
      initialVersion: { id: string };
    };
    workflowId = created.workflow.id;
    versionId = created.initialVersion.id;

    // stash org id for the tests
    orgId = org.id;
    operatorId = operator.id;
    void outsider;
  });

  let orgId = '';
  let operatorId = '';

  beforeEach(async () => {
    await stack.db.client.exec(
      'TRUNCATE wfos_v2_run_commands, wfos_v2_run_events, wfos_v2_run_attestation_rejections, ' +
      'wfos_v2_run_attestations, wfos_v2_run_evidence, wfos_v2_run_invocations, wfos_v2_run_steps, ' +
      'wfos_v2_run_attempts, wfos_v2_runs CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
    await stack.teardown();
  });

  async function inject(method: string, url: string, payload?: unknown, key = OPERATOR_KEY) {
    return app.inject({
      method: method as never,
      url,
      headers: { 'x-api-key': key },
      payload: payload === undefined ? undefined : (JSON.parse(JSON.stringify(payload)) as never),
    });
  }

  it('requires authentication (401 without credentials)', async () => {
    const res = await app.inject({ method: 'GET', url: `/workflow-runs/runs/wfr_missing` });
    expect(res.statusCode).toBe(401);
  });

  it('requests a run over HTTP (201) and replays the SAME command id (200, converged)', async () => {
    const body = {
      commandId: 'cmd-api-req-0001',
      correlationId: 'delivery-api-0001',
      causationId: 'evt-api-1',
      workflowId,
      versionId,
      trigger: { type: 'manual', id: 'manual-api-1' },
      inputCommitments: [commitmentOf('api-input')],
    };
    const first = await inject('POST', `/organizations/${orgId}/workflow-runs/runs`, body);
    expect(first.statusCode).toBe(201);
    const run = (first.json() as { run: { id: string; state: string } }).run;
    expect(run.state).toBe('requested');

    const replay = await inject('POST', `/organizations/${orgId}/workflow-runs/runs`, body);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { run: { id: string } }).run.id).toBe(run.id);
  });

  it('drives the full lifecycle over HTTP: start → step → pause → resume → complete', async () => {
    const requestRes = await inject('POST', `/organizations/${orgId}/workflow-runs/runs`, {
      commandId: 'cmd-api-req-0002',
      correlationId: 'delivery-api-0002',
      workflowId,
      versionId,
      trigger: { type: 'manual', id: 'manual-api-2' },
      inputCommitments: [commitmentOf('api-input-2')],
    });
    const runId = (requestRes.json() as { run: { id: string } }).run.id;

    const start = await inject('POST', `/workflow-runs/runs/${runId}/start`, {
      commandId: 'cmd-api-start-0002',
      correlationId: 'delivery-api-0002',
      nodeId: 'node_api_host_1',
    });
    expect(start.statusCode).toBe(200);
    expect((start.json() as { run: { state: string } }).run.state).toBe('running');

    const pause = await inject('POST', `/workflow-runs/runs/${runId}/pause`, {
      commandId: 'cmd-api-pause-0002',
      correlationId: 'delivery-api-0002',
      atStepId: 's1',
    });
    expect(pause.statusCode).toBe(200);
    expect((pause.json() as { run: { state: string } }).run.state).toBe('paused');

    const resume = await inject('POST', `/workflow-runs/runs/${runId}/resume`, {
      commandId: 'cmd-api-resume-0002',
      correlationId: 'delivery-api-0002',
    });
    expect(resume.statusCode).toBe(200);
    const resumed = resume.json() as { resumedAtStepId: string | null; newAttempt: boolean };
    expect(resumed.resumedAtStepId).toBe('s1');
    expect(resumed.newAttempt).toBe(false);

    const complete = await inject('POST', `/workflow-runs/runs/${runId}/complete`, {
      commandId: 'cmd-api-complete-0002',
      correlationId: 'delivery-api-0002',
      outputCommitments: [commitmentOf('api-output')],
    });
    expect(complete.statusCode).toBe(200);
    expect((complete.json() as { run: { state: string } }).run.state).toBe('completed');
  });

  it('records evidence over HTTP and reconstructs the history over HTTP', async () => {
    const requestRes = await inject('POST', `/organizations/${orgId}/workflow-runs/runs`, {
      commandId: 'cmd-api-req-0003',
      correlationId: 'delivery-api-0003',
      workflowId,
      versionId,
      trigger: { type: 'manual', id: 'manual-api-3' },
      inputCommitments: [],
    });
    const runId = (requestRes.json() as { run: { id: string } }).run.id;

    const evidence = await inject('POST', `/workflow-runs/runs/${runId}/evidence`, {
      commandId: 'cmd-api-ev-0003',
      correlationId: 'delivery-api-0003',
      evidenceClass: 'observation',
      producerKind: 'executor',
      producerId: 'node_api_host_1',
      contentCommitment: createHash('sha256').update('api-observation').digest('hex'),
      description: 'observed over HTTP',
    });
    expect(evidence.statusCode).toBe(201);
    const evidenceBody = evidence.json() as { evidence: { evidenceClass: string; created: boolean } };
    expect(evidenceBody.evidence.evidenceClass).toBe('observation');
    expect(evidenceBody.evidence.created).toBe(true);

    const history = await inject('GET', `/workflow-runs/runs/${runId}/history`);
    expect(history.statusCode).toBe(200);
    const historyBody = history.json() as {
      run: { id: string; state: string };
      timeline: { eventName: string }[];
      evidence: { evidenceClass: string; producerId: string }[];
      commands: { commandId: string }[];
    };
    expect(historyBody.run.id).toBe(runId);
    expect(historyBody.evidence.map((e) => e.evidenceClass)).toEqual(['observation']);
    expect(historyBody.timeline.map((e) => e.eventName)).toContain('observation.recorded');
    expect(historyBody.commands.map((c) => c.commandId)).toContain('cmd-api-ev-0003');
  });

  it('typed errors surface over HTTP with stable wire identifiers (uniform 404, no leak)', async () => {
    // cross-tenant read: uniform not-found
    const outsiderRead = await inject('GET', `/workflow-runs/runs/wfr_missing`, undefined, OUTSIDER_KEY);
    expect(outsiderRead.statusCode).toBe(404);
    expect((outsiderRead.json() as { error: string }).error).toBe('workflow-run-not-found');

    // illegal transition surfaces as the typed wire identifier
    const requestRes = await inject('POST', `/organizations/${orgId}/workflow-runs/runs`, {
      commandId: 'cmd-api-req-0004',
      correlationId: 'delivery-api-0004',
      workflowId,
      versionId,
      trigger: { type: 'manual', id: 'manual-api-4' },
      inputCommitments: [],
    });
    const runId = (requestRes.json() as { run: { id: string } }).run.id;
    const pause = await inject('POST', `/workflow-runs/runs/${runId}/pause`, {
      commandId: 'cmd-api-pause-0004',
      correlationId: 'delivery-api-0004',
    });
    expect(pause.statusCode).toBe(409);
    const pauseBody = pause.json() as { error: string; code: string };
    expect(pauseBody.error).toBe('workflow-run-invalid-state-transition');
    expect(pauseBody.code).toBe('RUN_INVALID_STATE_TRANSITION');

    // cross-tenant command: uniform not-found, state untouched
    const outsiderComplete = await inject('POST', `/workflow-runs/runs/${runId}/complete`, {
      commandId: 'cmd-api-outsider-complete',
      correlationId: 'delivery-api-0004',
    }, OUTSIDER_KEY);
    expect(outsiderComplete.statusCode).toBe(404);
    const reread = await inject('GET', `/workflow-runs/runs/${runId}`);
    expect((reread.json() as { run: { state: string } }).run.state).toBe('requested');
    void operatorId;
  });

  it('lists the tenant\'s runs over HTTP (member-scoped)', async () => {
    await inject('POST', `/organizations/${orgId}/workflow-runs/runs`, {
      commandId: 'cmd-api-req-0005',
      correlationId: 'delivery-api-0005',
      workflowId,
      versionId,
      trigger: { type: 'manual', id: 'manual-api-5' },
      inputCommitments: [],
    });
    const list = await inject('GET', `/organizations/${orgId}/workflow-runs/runs`);
    expect(list.statusCode).toBe(200);
    const runs = (list.json() as { runs: { id: string }[] }).runs;
    expect(runs.length).toBe(1);

    const outsiderList = await inject('GET', `/organizations/${orgId}/workflow-runs/runs`, undefined, OUTSIDER_KEY);
    expect(outsiderList.statusCode).toBe(403);
    expect((outsiderList.json() as { code: string }).code).toBe('RUN_NOT_ORGANIZATION_MEMBER');
  });
});

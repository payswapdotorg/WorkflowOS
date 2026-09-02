/**
 * V2-009 — the event-trigger integration battery (REAL STACK: PGlite + all
 * migrations + the real identity stack + the real V2-002 repository + the
 * real V2-005 run service + the real V2-004 node directory + the REAL
 * Fastify app with the REAL V2-002/V2-005/V2-009 routes, driven over HTTP
 * via app.inject()).
 *
 * Covers the work-order REQUIRED REGRESSIONS on the event side:
 *   - duplicate event (idempotent ingest; no second run; converged result);
 *   - concurrent trigger (parallel delivery of the SAME event → ONE run);
 *   - cross-device delivery (an event sourced on device A, placement
 *     resolves to device B — policy-driven, not source-driven);
 *   - event/run correlation (the run's trigger identity embeds the event
 *     identity; the delivery records the run id);
 * plus the typed event-schema rejections and the HTTP error surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import {
  buildTriggerTestStack,
  createPinnedNotifyWorkflow,
  createTenant,
  registerNode,
  type TriggerTestStack,
} from './trigger-test-support.js';
import { WorkflowDeploymentError } from '../../../src/workflow-deployments/index.js';

const API_KEY = 'v2-009-api-test-key';

let support: TriggerTestStack;
/** The REAL Fastify app: the auth plugin + the V2-009 routes (inject-driven). */
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  support = await buildTriggerTestStack({
    WFOS_V2_009_API_TEST_KEY: API_KEY,
  });
  // Provision the API key through the real credential provisioner (the
  // secret lives in the env secret store — the production path).
  const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
  await provisioner.provision({
    keyId: 'v2-009-api-test-key-id',
    secretRef: 'WFOS_V2_009_API_TEST_KEY',
    externalId: 'v2-009-api-operator',
    label: 'V2-009 API Operator',
    rawKey: API_KEY,
  });
  const authProvider = new ApiKeyAuthProvider(support.stack.db.client, new EnvSecretStore());
  app = await buildServer({
    queue: new InMemoryQueue(),
    logger: createLogger({ level: 'info' }),
    auth: { authProvider, userRepository: support.stack.userRepository },
    workflowDeployments: { workflowDeploymentService: support.deployments },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await support.teardown();
});

const CLOUD_POLICY = { placement: { required: 'cloud_allowed' as const }, privacy: { localOnly: false } };

interface EventTenant {
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly principal: { userId: string };
}

async function freshEventTenant(label: string): Promise<EventTenant> {
  // The API key principal is the provisioned operator user; the tenant is a
  // fresh org owned by THAT user (the key authorizes the org scope).
  const operator = await support.stack.userRepository.upsertByExternalId({
    externalId: 'v2-009-api-operator',
    displayName: 'V2-009 API Operator',
  });
  const tenant = await createTenant(support, `evt-${label}`);
  // Re-assign the tenant to the operator (the API-key principal).
  await support.stack.membershipRepository.assign({
    userId: operator.id,
    organizationId: tenant.organizationId,
    roleId: 'owner',
  });
  return {
    organizationId: tenant.organizationId,
    ownerUserId: operator.id,
    principal: { userId: operator.id },
  };
}

/** The real HTTP event-ingest call (the product path). */
async function postEvent(
  t: EventTenant,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: `/organizations/${t.organizationId}/workflow-deployments/events`,
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    payload: body,
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function postTick(t: EventTenant): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: `/organizations/${t.organizationId}/workflow-deployments/tick`,
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** Create the full deployment + event subscription for the file.changed pattern. */
async function createEventDeployment(
  t: EventTenant,
  options?: { readonly placement?: Record<string, unknown>; readonly pattern?: Record<string, unknown> },
) {
  const pinned = await createPinnedNotifyWorkflow(support, t);
  const { deployment } = await support.deployments.createDeployment(t.principal, {
    organizationId: t.organizationId,
    workflowId: pinned.workflowId,
    versionId: pinned.versionId,
    installationId: pinned.installationId,
    name: 'event-dep',
    placement: (options?.placement ?? CLOUD_POLICY) as never,
  });
  const { subscription } = await support.deployments.createSubscription(t.principal, {
    deploymentId: deployment.id,
    kind: 'event',
    eventPattern: (options?.pattern ?? { eventType: 'file.changed' }) as never,
  });
  return { deployment, subscription, pinned };
}

describe('V2-009 — REQUIRED REGRESSION: duplicate event (idempotent delivery)', () => {
  it('the SAME (source, eventId) delivered twice converges: ONE inbox row, ONE delivery, ONE run', async () => {
    const t = await freshEventTenant('dup');
    registerNode(support.nodes, 'v2-009-dup-device', 'desktop');
    await createEventDeployment(t);

    const event = {
      source: 'node_dup_device',
      eventId: 'filechange-0001',
      eventType: 'file.changed',
      payload: { path: '/inbox/invoice-001.txt' },
    };
    const first = await postEvent(t, event);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const firstDeliveries = (first.body.deliveries as Record<string, unknown>[]) ?? [];
    expect(firstDeliveries).toHaveLength(1);
    expect(firstDeliveries[0]!.state).toBe('delivered');
    const firstRunId = firstDeliveries[0]!.runId as string;
    expect(firstRunId).toBeTruthy();

    // THE DUPLICATE: same source + same event id (a producer retry).
    const second = await postEvent(t, event);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.matchedSubscriptionIds).toEqual([]);
    expect((second.body.deliveries as unknown[]).length).toBe(0);

    // Exactly ONE run exists for the org (no second side effect).
    const runs = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(firstRunId);
  });

  it('the same event id from a DIFFERENT source is a DIFFERENT event (two runs)', async () => {
    const t = await freshEventTenant('dup-source');
    registerNode(support.nodes, 'v2-009-dup-source-device', 'desktop');
    await createEventDeployment(t);
    const payload = { path: '/shared/notes.md' };
    const a = await postEvent(t, { source: 'node_a', eventId: 'evt-1', eventType: 'file.changed', payload });
    const b = await postEvent(t, { source: 'node_b', eventId: 'evt-1', eventType: 'file.changed', payload });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const runs = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runs).toHaveLength(2);
  });
});

describe('V2-009 — REQUIRED REGRESSION: concurrent trigger', () => {
  it('the SAME event delivered CONCURRENTLY converges on ONE run (both layers: delivery + run)', async () => {
    const t = await freshEventTenant('concurrent');
    registerNode(support.nodes, 'v2-009-concurrent-device', 'desktop');
    await createEventDeployment(t);
    const event = {
      source: 'node_concurrent',
      eventId: 'filechange-race-0001',
      eventType: 'file.changed',
      payload: { path: '/inbox/race.txt' },
    };
    // Two concurrent HTTP ingests of the SAME event.
    const [a, b] = await Promise.all([postEvent(t, event), postEvent(t, event)]);
    const statuses = [a.status, b.status].sort();
    // One created (201), one converged (200) — never two creations.
    expect(statuses).toEqual([200, 201]);
    const runs = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runs).toHaveLength(1);
    // The converged response references the SAME durable event identity.
    expect((a.body.event as Record<string, unknown>).id).toBe((b.body.event as Record<string, unknown>).id);
  });

  it('two PARALLEL ticks over the same due schedule converge on ONE delivery + ONE run', async () => {
    const t = await freshEventTenant('concurrent-tick');
    registerNode(support.nodes, 'v2-009-tick-race', 'desktop');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'tick-race-dep',
      placement: CLOUD_POLICY,
    });
    await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'interval', everyMs: 60_000 },
    });
    support.clock.advance(120_000);
    const [a, b] = await Promise.all([
      support.deployments.tick(t.principal, { organizationId: t.organizationId }),
      support.deployments.tick(t.principal, { organizationId: t.organizationId }),
    ]);
    // Exactly one delivered/converged across both ticks (never two runs).
    const deliveredIds = [...a.deliveriesDelivered, ...b.deliveriesDelivered];
    const convergedIds = [...a.deliveriesConverged, ...b.deliveriesConverged];
    expect(deliveredIds.length + convergedIds.length).toBeGreaterThanOrEqual(1);
    const runs = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runs).toHaveLength(1);
    const deliveries = await support.deployments.listDeliveriesForDeployment(t.principal, deployment.id);
    const terminal = deliveries.filter((d) => d.state === 'delivered' || d.state === 'converged');
    expect(terminal).toHaveLength(1);
  });
});

describe('V2-009 — REQUIRED REGRESSION: cross-device delivery + event/run correlation', () => {
  it('an event SOURCED on device A delivers a run PLACED on device B (policy-driven placement)', async () => {
    const t = await freshEventTenant('cross-device');
    // TWO devices registered; the event's SOURCE is device A's identity.
    const deviceA = registerNode(support.nodes, 'v2-009-cross-a', 'desktop');
    const deviceB = registerNode(support.nodes, 'v2-009-cross-b', 'desktop');
    // device_preferred: the deterministic preference order is
    // (placementRank, nodeId) — the lower node id wins.
    const expected = [deviceA.nodeId, deviceB.nodeId].sort()[0]!;
    await createEventDeployment(t, {
      placement: { placement: { required: 'device_preferred' }, privacy: { localOnly: false } },
    });
    const result = await postEvent(t, {
      source: deviceA.nodeId,
      eventId: 'cross-device-0001',
      eventType: 'file.changed',
      payload: { path: '/device-a/inbox/report.txt' },
    });
    expect(result.status).toBe(201);
    const delivery = (result.body.deliveries as Record<string, unknown>[])[0]!;
    // The placement resolved by POLICY (deterministic preference), not by
    // the event's source: the chosen node is the policy's preference.
    expect(delivery.resolvedNodeId).toBe(expected);
    expect(delivery.runId).toBeTruthy();
    // CORRELATION: the run's trigger identity embeds the event identity.
    const run = await support.runs.getRun(t.principal, delivery.runId as string);
    expect(run.trigger.type).toBe('file_event');
    expect(run.trigger.id).toBe(`evt:${(result.body.event as Record<string, unknown>).id}:${(result.body.matchedSubscriptionIds as string[])[0]}`);
    expect(run.installationId).not.toBeNull();
  });

  it('the delivery read carries the full correlation surface (typed, tenant-scoped)', async () => {
    const t = await freshEventTenant('correlation');
    registerNode(support.nodes, 'v2-009-corr-device', 'desktop');
    const { deployment } = await createEventDeployment(t);
    const result = await postEvent(t, {
      source: 'node_corr',
      eventId: 'corr-0001',
      eventType: 'file.changed',
      payload: { path: '/reports/q3.md' },
    });
    expect(result.status).toBe(201);
    const deliveryId = ((result.body.deliveries as Record<string, unknown>[])[0]!.id) as string;
    const response = await app.inject({
      method: 'GET',
      url: `/workflow-deployments/deliveries/${deliveryId}`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    const delivery = body.delivery as Record<string, unknown>;
    expect(delivery.deploymentId).toBe(deployment.id);
    expect(delivery.state).toBe('delivered');
    expect(delivery.kind).toBe('event');
    expect(delivery.triggerKey).toBe(`evt:${(result.body.event as Record<string, unknown>).id}`);
    expect(delivery.runId).toBeTruthy();
    expect((delivery.attempts as unknown[]).length).toBe(1);
  });
});

describe('V2-009 — typed event schemas at the boundary (fail-closed)', () => {
  it('an unknown event type is typed EVENT_TYPE_UNKNOWN (registry vocabulary only)', async () => {
    const t = await freshEventTenant('schema-unknown');
    const result = await postEvent(t, {
      source: 'node_schema',
      eventId: 'schema-0001',
      eventType: 'file.deleted',
      payload: { path: '/tmp/x' },
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('EVENT_TYPE_UNKNOWN');
  });

  it('a payload violating the typed schema is typed EVENT_SCHEMA_INVALID', async () => {
    const t = await freshEventTenant('schema-invalid');
    const result = await postEvent(t, {
      source: 'node_schema',
      eventId: 'schema-0002',
      eventType: 'file.changed',
      payload: { digest: 'missing the required path' },
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('EVENT_SCHEMA_INVALID');
  });

  it('a subscription match on an UNDECLARED field is rejected at subscription creation (typed)', async () => {
    const t = await freshEventTenant('schema-match');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'bad-match-dep',
      placement: CLOUD_POLICY,
    });
    try {
      await support.deployments.createSubscription(t.principal, {
        deploymentId: deployment.id,
        kind: 'event',
        eventPattern: { eventType: 'file.changed', match: [{ field: 'pathname', value: '/x' }] },
      });
      expect.unreachable('must reject');
    } catch (error) {
      expect((error as WorkflowDeploymentError).code).toBe('SUBSCRIPTION_EVENT_MATCH_INVALID');
    }
  });
});

describe('V2-009 — typed subscription matching (source + field filters)', () => {
  it('a source-filtered pattern matches ONLY that source; typed field values match exactly', async () => {
    const t = await freshEventTenant('matching');
    registerNode(support.nodes, 'v2-009-match-device', 'desktop');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'match-dep',
      placement: CLOUD_POLICY,
    });
    await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'event',
      eventPattern: {
        eventType: 'file.changed',
        source: 'watched-folder-agent',
        match: [{ field: 'path', value: '/watched/report.md' }],
      },
    });

    // A matching event → one delivery.
    const hit = await postEvent(t, {
      source: 'watched-folder-agent',
      eventId: 'match-0001',
      eventType: 'file.changed',
      payload: { path: '/watched/report.md' },
    });
    expect(hit.status).toBe(201);
    expect((hit.body.matchedSubscriptionIds as string[]).length).toBe(1);

    // Wrong source → ingested (201) but NO match, NO run.
    const wrongSource = await postEvent(t, {
      source: 'other-agent',
      eventId: 'match-0002',
      eventType: 'file.changed',
      payload: { path: '/watched/report.md' },
    });
    expect(wrongSource.status).toBe(201);
    expect((wrongSource.body.matchedSubscriptionIds as string[]).length).toBe(0);

    // Wrong field value → no match.
    const wrongPath = await postEvent(t, {
      source: 'watched-folder-agent',
      eventId: 'match-0003',
      eventType: 'file.changed',
      payload: { path: '/other/file.md' },
    });
    expect(wrongPath.status).toBe(201);
    expect((wrongPath.body.matchedSubscriptionIds as string[]).length).toBe(0);

    const runs = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runs).toHaveLength(1);
  });
});

describe('V2-009 — the engine tick over HTTP (no hidden autonomous engine)', () => {
  it('the tick route advances the org engine on demand (deterministic given clock + state)', async () => {
    const t = await freshEventTenant('http-tick');
    registerNode(support.nodes, 'v2-009-http-tick', 'desktop');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'http-tick-dep',
      placement: CLOUD_POLICY,
    });
    await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: new Date(support.clock.now() + 30_000).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z') },
    });
    support.clock.advance(60_000);
    const tick = await postTick(t);
    expect(tick.status).toBe(200);
    expect((tick.body.occurrencesConsidered as number)).toBe(1);
    expect((tick.body.deliveriesDelivered as string[]).length).toBe(1);

    // Unauthorized access is rejected (backend-authorized routes).
    const anon = await app.inject({ method: 'POST', url: `/organizations/${t.organizationId}/workflow-deployments/tick` });
    expect(anon.statusCode).toBe(401);
  });
});

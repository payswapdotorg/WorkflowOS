/**
 * V2-009 — the core integration battery (REAL STACK: PGlite + all migrations
 * incl. 0062 + the real identity stack + the real V2-002 repository + the
 * real V2-005 run service + the real V2-004 node directory).
 *
 * Covers the work-order REQUIRED REGRESSIONS on the schedule/placement side:
 *   - missed schedule (skip + catch-up latest-only + superseded backlog);
 *   - disabled workflow (skipped_disabled, no run);
 *   - placement failure (typed, bounded retries, terminal failure);
 *   - offline device recovery (pending until the device appears in the real
 *     node directory, then delivered);
 *   - timezone correctness on the REAL clock (one-shot + Accra wall-clock);
 *   - manual launch (enable-gated) + deployment lifecycle + convergence.
 *
 * Every test drives a FRESH TENANT: the tick sweep is org-scoped, so
 * per-test tenants keep the pending-retry accounting isolated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commitmentOf,
  createPinnedNotifyWorkflow,
  createTenant,
  registerNode,
  buildTriggerTestStack,
  versionContentOf,
  authorMixedLocalityDocument,
  TRIGGER_CLOCK_BASE_MS,
  type SharedClock,
  type TriggerTestStack,
} from './trigger-test-support.js';
import { WorkflowDeploymentError, formatUtcTimestamp } from '../../../src/workflow-deployments/index.js';

let support: TriggerTestStack;

beforeAll(async () => {
  support = await buildTriggerTestStack();
});

afterAll(async () => {
  await support.teardown();
});

interface Tenant {
  readonly support: TriggerTestStack;
  readonly clock: SharedClock;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly principal: { userId: string };
  readonly tick: () => Promise<ReturnType<TriggerTestStack['deployments']['tick']> extends Promise<infer R> ? R : never>;
}

async function freshTenant(label: string): Promise<Tenant> {
  const tenant = await createTenant(support, label);
  const principal = { userId: tenant.ownerUserId };
  return {
    support,
    clock: support.clock,
    organizationId: tenant.organizationId,
    ownerUserId: tenant.ownerUserId,
    principal,
    tick: () => support.deployments.tick(principal, { organizationId: tenant.organizationId }),
  };
}

const CLOUD_POLICY = { placement: { required: 'cloud_allowed' as const }, privacy: { localOnly: false } };

describe('V2-009 — deployment lifecycle (the version-to-execution binding)', () => {
  it('creates a deployment pinning the EXACT installed version (created=true)', async () => {
    const t = await freshTenant('create-ok');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    const result = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'notify-daily',
      placement: CLOUD_POLICY,
    });
    expect(result.created).toBe(true);
    expect(result.deployment.workflowId).toBe(pinned.workflowId);
    expect(result.deployment.versionId).toBe(pinned.versionId);
    expect(result.deployment.installationId).toBe(pinned.installationId);
    expect(result.deployment.enabled).toBe(true);
    expect(result.deployment.id).toMatch(/^dep_[0-9a-f]{16}$/);
  });

  it('duplicate create CONVERGES on the deterministic pin surface (created=false, same id)', async () => {
    const t = await freshTenant('create-dup');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    const input = {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'notify-daily-dup',
      placement: CLOUD_POLICY,
    };
    const first = await support.deployments.createDeployment(t.principal, input);
    const second = await support.deployments.createDeployment(t.principal, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.deployment.id).toBe(first.deployment.id);
  });

  it('REJECTS a plan-incompatible placement policy (typed DEPLOYMENT_PLAN_INCOMPATIBLE)', async () => {
    const t = await freshTenant('compat-reject');
    const created = await support.repository.createWorkflow(t.principal, {
      organizationId: t.organizationId,
      slug: `mixed-${t.organizationId.slice(0, 8)}`,
      name: 'Mixed locality workflow',
      description: null,
      visibility: 'private',
      content: versionContentOf(authorMixedLocalityDocument()),
      protocol: { irSchemaVersion: 'test-ir-1' },
    });
    try {
      await support.deployments.createDeployment(t.principal, {
        organizationId: t.organizationId,
        workflowId: created.workflow.id,
        versionId: created.workflow.headVersionId!,
        installationId: null,
        name: 'cloud-only-mixed',
        placement: { placement: { required: 'cloud_required' }, privacy: { localOnly: false } },
      });
      expect.unreachable('must reject');
    } catch (error) {
      expect((error as WorkflowDeploymentError).code).toBe('DEPLOYMENT_PLAN_INCOMPATIBLE');
      expect((error as WorkflowDeploymentError).detail).toContain('device_local');
    }
  });

  it('enable/disable is user-visible state with typed same-state rejections', async () => {
    const t = await freshTenant('toggle');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'toggle-me',
      placement: CLOUD_POLICY,
    });
    const disabled = await support.deployments.setDeploymentEnabled(t.principal, {
      deploymentId: deployment.id,
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledAt).not.toBeNull();
    try {
      await support.deployments.setDeploymentEnabled(t.principal, { deploymentId: deployment.id, enabled: false });
      expect.unreachable('must reject');
    } catch (error) {
      expect((error as WorkflowDeploymentError).code).toBe('DEPLOYMENT_ALREADY_DISABLED');
    }
    const reEnabled = await support.deployments.setDeploymentEnabled(t.principal, {
      deploymentId: deployment.id,
      enabled: true,
    });
    expect(reEnabled.enabled).toBe(true);
    expect(reEnabled.enabledAt).not.toBeNull();
  });

  it('cross-tenant reads are typed rejections (no existence leak)', async () => {
    const t = await freshTenant('cross-tenant');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'private-one',
      placement: CLOUD_POLICY,
    });
    try {
      await support.deployments.getDeployment({ userId: support.userBId }, deployment.id);
      expect.unreachable('must reject');
    } catch (error) {
      expect((error as WorkflowDeploymentError).code).toBe('DEPLOYMENT_NOT_ORGANIZATION_MEMBER');
    }
  });
});

describe('V2-009 — one-shot schedule → a real run through the V2-005 boundary', () => {
  it('fires a due one-shot occurrence: the run is created with trigger type schedule + the occurrence identity', async () => {
    const t = await freshTenant('one-shot');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    const device = registerNode(support.nodes, 'v2-009-one-shot-device', 'desktop');
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'one-shot-dep',
      placement: { placement: { required: 'device_preferred' }, privacy: { localOnly: false } },
    });
    const fireAt = formatUtcTimestamp(t.clock.now() + 60_000);
    const { subscription } = await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: fireAt },
    });
    expect(subscription.id).toMatch(/^sub_[0-9a-f]{16}$/);

    t.clock.advance(120_000);
    const tick = await t.tick();
    expect(tick.occurrencesConsidered).toBe(1);
    expect(tick.deliveriesDelivered).toHaveLength(1);

    const delivery = await support.deployments.getDelivery(t.principal, tick.deliveriesDelivered[0]!);
    expect(delivery.state).toBe('delivered');
    expect(delivery.scheduledAt).toBe(fireAt);
    expect(delivery.runId).not.toBeNull();
    expect(delivery.resolvedNodeId).toBe(device.nodeId);
    expect(delivery.resolvedPlacement).toBe('device_preferred');

    // The run itself (the REAL V2-005 record): schedule trigger + occurrence id.
    const run = await support.runs.getRun(t.principal, delivery.runId!);
    expect(run.trigger.type).toBe('schedule');
    expect(run.trigger.id).toBe(`sch:${subscription.id}:${fireAt}`);
    expect(run.state).toBe('requested');
  });

  it('a second tick does NOT refire (the cursor is strictly-after; idempotent)', async () => {
    const t = await freshTenant('no-refire');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    registerNode(support.nodes, 'v2-009-no-refire', 'desktop');
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'no-refire-dep',
      placement: CLOUD_POLICY,
    });
    await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: formatUtcTimestamp(t.clock.now() + 30_000) },
    });
    t.clock.advance(60_000);
    const first = await t.tick();
    const second = await t.tick();
    expect(first.deliveriesDelivered).toHaveLength(1);
    expect(second.occurrencesConsidered).toBe(0);
    expect(second.deliveriesDelivered).toHaveLength(0);
    const deliveries = await support.deployments.listDeliveriesForDeployment(t.principal, deployment.id);
    expect(deliveries).toHaveLength(1);
  });
});

describe('V2-009 — recurring wall-clock schedules (Africa/Accra — timezone correctness)', () => {
  it('a daily 09:00 Africa/Accra schedule fires at 09:00Z on the real injected clock', async () => {
    const t = await freshTenant('accra-daily');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    registerNode(support.nodes, 'v2-009-accra', 'desktop');
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'accra-daily',
      placement: CLOUD_POLICY,
    });
    await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '09:00' },
    });
    // Advance to just past the NEXT 09:00Z boundary (Accra is GMT+0; the
    // shared clock has already accumulated earlier tests' advances).
    const now = t.clock.now();
    const base09 = Date.UTC(2026, 8, 1, 9, 0); // base day 2026-09-01 09:00Z
    const next09 = now < base09 ? base09 : base09 + Math.ceil((now - base09) / 86_400_000) * 86_400_000;
    t.clock.advance(next09 - now + 1_000);
    const tick = await t.tick();
    expect(tick.deliveriesDelivered).toHaveLength(1);
    const delivery = await support.deployments.getDelivery(t.principal, tick.deliveriesDelivered[0]!);
    expect(delivery.scheduleResolution).toBe('normal');
    expect(delivery.scheduledAt!.endsWith('T09:00:00.000Z')).toBe(true);
  });
});

describe('V2-009 — REQUIRED REGRESSION: missed schedule', () => {
  it('skip policy: an occurrence that aged out is MISSED — no run, honest attempt record', async () => {
    const t = await freshTenant('missed-skip');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    registerNode(support.nodes, 'v2-009-missed', 'desktop');
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'missed-skip',
      placement: CLOUD_POLICY,
    });
    const fireAt = formatUtcTimestamp(t.clock.now() + 30_000);
    await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: fireAt },
      deliveryPolicy: { missWindowMs: 60_000, missedWindow: 'skip' },
    });
    // Advance FAR past the window, then tick.
    t.clock.advance(10 * 60_000);
    const tick = await t.tick();
    expect(tick.deliveriesMissed).toHaveLength(1);
    expect(tick.deliveriesDelivered).toHaveLength(0);
    const delivery = await support.deployments.getDelivery(t.principal, tick.deliveriesMissed[0]!);
    expect(delivery.state).toBe('missed');
    expect(delivery.missedWindowApplied).toBe('skip');
    expect(delivery.runId).toBeNull();
    expect(delivery.attempts).toHaveLength(1);
    expect(delivery.attempts[0]!.outcome).toBe('missed_window');
  });

  it('catch_up policy: ONLY the latest missed occurrence fires; older ones are SUPERSEDED (bounded, no backlog)', async () => {
    const t = await freshTenant('catch-up');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    registerNode(support.nodes, 'v2-009-catchup', 'desktop');
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'catch-up',
      placement: CLOUD_POLICY,
    });
    await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'interval', everyMs: 60_000 },
      deliveryPolicy: { missWindowMs: 10 * 60_000, missedWindow: 'catch_up_run_now' },
    });
    // Advance 5 minutes (5+ due occurrences), then tick.
    t.clock.advance(5 * 60_000 + 1_000);
    const tick = await t.tick();
    expect(tick.occurrencesConsidered).toBeGreaterThanOrEqual(5);
    expect(tick.deliveriesDelivered).toHaveLength(1); // ONLY the latest fires
    expect(tick.deliveriesSuperseded).toHaveLength(tick.occurrencesConsidered - 1);
    const deliveries = await support.deployments.listDeliveriesForDeployment(t.principal, deployment.id);
    expect(deliveries.filter((d) => d.state === 'superseded').length).toBe(
      tick.occurrencesConsidered - 1,
    );
    const delivered = deliveries.find((d) => d.state === 'delivered');
    expect(delivered).toBeDefined();
    expect(delivered!.runId).not.toBeNull();
  });
});

describe('V2-009 — REQUIRED REGRESSION: disabled workflow (enable/disable semantics)', () => {
  it('a disabled deployment SKIPS due occurrences (skipped_disabled, no run)', async () => {
    const t = await freshTenant('disabled-skip');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    registerNode(support.nodes, 'v2-009-disabled', 'desktop');
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'disabled-dep',
      placement: CLOUD_POLICY,
    });
    await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: formatUtcTimestamp(t.clock.now() + 30_000) },
    });
    await support.deployments.setDeploymentEnabled(t.principal, { deploymentId: deployment.id, enabled: false });
    t.clock.advance(60_000);
    const tick = await t.tick();
    expect(tick.deliveriesSkippedDisabled).toHaveLength(1);
    expect(tick.deliveriesDelivered).toHaveLength(0);
    const delivery = await support.deployments.getDelivery(t.principal, tick.deliveriesSkippedDisabled[0]!);
    expect(delivery.state).toBe('skipped_disabled');
    expect(delivery.runId).toBeNull();
    expect(delivery.attempts[0]!.outcome).toBe('disabled');
  });

  it('manual launch of a disabled deployment is typed TRIGGER_MANUAL_DISABLED; enabled works', async () => {
    const t = await freshTenant('manual');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    registerNode(support.nodes, 'v2-009-manual', 'desktop');
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'manual-dep',
      placement: CLOUD_POLICY,
    });
    const launched = await support.deployments.triggerManualRun(t.principal, {
      deploymentId: deployment.id,
      commandId: 'cmd-manual-0001',
      correlationId: 'corr-manual-0001',
      inputCommitments: [commitmentOf('manual-launch-input')],
    });
    expect(launched.created).toBe(true);
    const run = await support.runs.getRun(t.principal, launched.runId);
    expect(run.trigger.type).toBe('manual');
    expect(run.trigger.id).toBe('man:cmd-manual-0001');

    await support.deployments.setDeploymentEnabled(t.principal, { deploymentId: deployment.id, enabled: false });
    try {
      await support.deployments.triggerManualRun(t.principal, {
        deploymentId: deployment.id,
        commandId: 'cmd-manual-0002',
        correlationId: 'corr-manual-0002',
        inputCommitments: [],
      });
      expect.unreachable('must reject');
    } catch (error) {
      expect((error as WorkflowDeploymentError).code).toBe('TRIGGER_MANUAL_DISABLED');
    }
  });
});

describe('V2-009 — REQUIRED REGRESSION: placement failure', () => {
  it('no eligible node AT ALL → bounded retries (deterministic backoff) → terminal typed failure', async () => {
    const t = await freshTenant('placement-fail');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    // ISOLATED empty node directory: no eligible node EVER (the shared
    // directory carries earlier tests' devices).
    const emptyNodes = support.freshNodes();
    const deployments = support.makeDeployments(emptyNodes);
    // localOnly deployment with NO device registered → no eligible node ever.
    const { deployment } = await deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'no-node-dep',
      placement: { placement: { required: 'device_local' }, privacy: { localOnly: true } },
    });
    await deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: formatUtcTimestamp(t.clock.now() + 30_000) },
      deliveryPolicy: { maxAttempts: 3, backoffBaseMs: 1_000, backoffMaxMs: 4_000, missWindowMs: 86_400_000, missedWindow: 'skip' },
    });
    t.clock.advance(60_000);
    // Tick 1: first placement attempt fails → pending with retryAt.
    const tick1 = await deployments.tick(t.principal, { organizationId: t.organizationId });
    expect(tick1.stillPending).toHaveLength(1);
    let delivery = await support.deployments.getDelivery(t.principal, tick1.stillPending[0]!.deliveryId);
    expect(delivery.state).toBe('pending');
    expect(delivery.attempts).toHaveLength(1);
    expect(delivery.attempts[0]!.outcome).toBe('placement_unavailable');
    expect(delivery.runId).toBeNull();

    // Advance past the backoff and tick again (attempt 2).
    t.clock.advance(2_000);
    await deployments.tick(t.principal, { organizationId: t.organizationId });
    delivery = await support.deployments.getDelivery(t.principal, delivery.id);
    expect(delivery.attempts).toHaveLength(2);

    // Attempt 3 exhausts the budget → terminal typed failure.
    t.clock.advance(4_000);
    const tick3 = await deployments.tick(t.principal, { organizationId: t.organizationId });
    expect(tick3.deliveriesFailed).toHaveLength(1);
    delivery = await support.deployments.getDelivery(t.principal, delivery.id);
    expect(delivery.state).toBe('failed');
    expect(delivery.failure!.code).toBe('TRIGGER_PLACEMENT_UNAVAILABLE');
    expect(delivery.runId).toBeNull();
  });
});

describe('V2-009 — REQUIRED REGRESSION: offline device recovery', () => {
  it('a device-local delivery PENDS while the device is offline, then delivers after the device appears', async () => {
    const t = await freshTenant('offline-recovery');
    const pinned = await createPinnedNotifyWorkflow(support, t);
    // ISOLATED node directory: starts EMPTY (the device is offline).
    const nodes = support.freshNodes();
    const deployments = support.makeDeployments(nodes);
    const { deployment } = await deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId: pinned.workflowId,
      versionId: pinned.versionId,
      installationId: pinned.installationId,
      name: 'offline-recovery',
      placement: { placement: { required: 'device_local' }, privacy: { localOnly: true } },
    });
    await deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: formatUtcTimestamp(t.clock.now() + 30_000) },
      deliveryPolicy: { maxAttempts: 10, backoffBaseMs: 1_000, backoffMaxMs: 8_000, missWindowMs: 86_400_000, missedWindow: 'skip' },
    });
    t.clock.advance(60_000);
    const tick1 = await deployments.tick(t.principal, { organizationId: t.organizationId });
    expect(tick1.stillPending).toHaveLength(1);
    const deliveryId = tick1.stillPending[0]!.deliveryId;

    // The device comes ONLINE (registers through the real V2-004 protocol
    // into the SAME isolated directory).
    const device = registerNode(nodes, 'v2-009-recovered-device', 'desktop');
    // Advance past the backoff and tick: the delivery should now resolve.
    t.clock.advance(2_000);
    const tick2 = await deployments.tick(t.principal, { organizationId: t.organizationId });
    expect(tick2.deliveriesDelivered).toContain(deliveryId);
    const delivery = await support.deployments.getDelivery(t.principal, deliveryId);
    expect(delivery.state).toBe('delivered');
    expect(delivery.resolvedNodeId).toBe(device.nodeId);
    expect(delivery.runId).not.toBeNull();
    const run = await support.runs.getRun(t.principal, delivery.runId!);
    expect(run.trigger.type).toBe('schedule');
  });
});

describe('V2-009 — shared clock sanity (the time source is injected everywhere)', () => {
  it('the trigger clock observes the injected epoch (base + advances)', () => {
    expect(support.clock.utc()).toBe(formatUtcTimestamp(support.clock.now()));
    expect(support.clock.now()).toBeGreaterThanOrEqual(TRIGGER_CLOCK_BASE_MS);
  });
});

/**
 * V2-009 — REQUIRED REAL-SYSTEM DOGFOODING EXPERIMENT (dogfooding-protocol.md;
 * work order V2-009 "Dogfooding" + the frozen protocol table row: "Run one
 * scheduled workflow and one supported event-triggered workflow. Verify
 * duplicate-event behavior and placement.").
 *
 * Runs the experiment through REAL product paths:
 *
 *   real PGlite (actual PostgreSQL compiled to WASM — the platform's
 *   pglite-database-client, the same single persistence boundary as
 *   production `pg`) → real migration-runner (ALL 62 migrations incl.
 *   0062_workflow_deployments_v2.sql) → real identity stack (users /
 *   organizations / memberships / API-key auth provider + credential
 *   provisioner) → REAL Fastify app built by buildServer with the REAL
 *   V2-002 workflow-repository routes AND the REAL V2-005 workflow-runs
 *   routes AND the REAL V2-009 workflow-deployments routes → every step
 *   driven over HTTP via app.inject() → the device node registered through
 *   the REAL V2-004 protocol (key enrollment from a SHA-256 seed → nonce
 *   challenge → HMAC-SHA256 challenge-response → registration → trust).
 *
 * Experiment:
 *
 *   1. SCHEDULED WORKFLOW — author the morning-briefing workflow with the
 *      merged V2-003 builder, create + INSTALL (pin) its immutable version 1
 *      through the real V2-002 routes, deploy it with a device_preferred
 *      placement policy and a DAILY 09:00 Africa/Accra wall-clock schedule
 *      (the user timezone), advance the injected clock past 09:00Z and POST
 *      the engine tick through the real route. The run is created through
 *      the REAL V2-005 boundary; the delivery records the placement
 *      resolution (the registered device node, placement rank 0).
 *   2. EVENT WORKFLOW — a second deployment subscribes to file.changed
 *      events (typed schema) sourced from the device, matching the REAL
 *      path of a REAL file written to the real filesystem (with its real
 *      sha-256 digest in the typed payload). The event is delivered through
 *      the real ingest route; the run is created; the run's trigger
 *      identity embeds the inbox event identity (event/run correlation).
 *   3. DUPLICATE SUPPRESSION — the SAME (source, eventId) delivered again
 *      converges (HTTP 200, created=false, zero new deliveries); the run
 *      list proves exactly ONE event run (no second side effect).
 *   4. PLACEMENT BEHAVIOR — (a) the device_preferred deployments resolve to
 *      the registered device node at placement rank 0 (recorded on both
 *      deliveries); (b) a localOnly deployment with NO device in its
 *      isolated directory PENDS (typed placement_unavailable, deterministic
 *      backoff), and the offline device's registration through the real
 *      protocol recovers the delivery on the next tick.
 *   5. NEGATIVE — a disabled deployment's due occurrence is honestly
 *      skipped (skipped_disabled, no run) — enable/disable is real.
 *   6. DETERMINISM — the whole experiment runs TWICE (fresh PGlite + fresh
 *      identity stack per run); the transcripts are compared after
 *      normalizing run-scoped bookkeeping (uuid-derived org/workflow/
 *      version/installation ids, the derived dep_/sub_/evt_/dlv_/run_ ids,
 *      node ids, timestamps) — the V2-005/V2-006 precedent.
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/workflow-deployments/run-scheduled-and-event-trigger-dogfooding.ts
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import { createWorkflowIrBuilder, serializeWorkflowIrDocument, type WorkflowNode } from '../../../src/workflow-ir/index.js';
import {
  buildTriggerTestStack,
  registerNode,
  type SharedClock,
  type TriggerTestStack,
} from './trigger-test-support.js';

const API_KEY = 'v2-009-dogfooding-api-key';
const TRANSCRIPT_LINES: string[] = [];

function line(text = ''): void {
  TRANSCRIPT_LINES.push(text);
  // eslint-disable-next-line no-console
  console.log(text);
}

/** sha-256 hex over real bytes (the real one-way commitment). */
function sha256HexOf(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ============================================================================
// The morning-briefing workflow (authored through the real V2-003 builder)
// ============================================================================

const summarizeNode: WorkflowNode = {
  id: 'send_briefing',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'messaging.send' },
  capabilityRequirements: ['messaging.send'],
  placement: 'cloud_allowed',
  inputs: [],
  outputs: [{ name: 'messageId', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'observation',
};

function authorMorningBriefingDocument() {
  return createWorkflowIrBuilder()
    .withStart('send_briefing')
    .addWorkflowInput({ name: 'briefing', type: { kind: 'string' } })
    .addNode(summarizeNode)
    .build();
}

// ============================================================================
// One dogfooding RUN (the experiment; returns the normalized transcript)
// ============================================================================

async function runExperiment(): Promise<string[]> {
  const support: TriggerTestStack = await buildTriggerTestStack({
    WFOS_V2_009_DOGFOODING_KEY: API_KEY,
  });
  const clock: SharedClock = support.clock;
  TRANSCRIPT_LINES.length = 0;

  try {
    // --- the real HTTP app (V2-002 + V2-005 + V2-009 routes) --------------
    const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
    await provisioner.provision({
      keyId: 'v2-009-dogfooding-key',
      secretRef: 'WFOS_V2_009_DOGFOODING_KEY',
      externalId: 'v2-009-dogfooding-operator',
      label: 'V2-009 Dogfooding Operator',
      rawKey: API_KEY,
    });
    const authProvider = new ApiKeyAuthProvider(support.stack.db.client, new EnvSecretStore());
    const app: FastifyInstance = await buildServer({
      queue: new InMemoryQueue(),
      logger: createLogger({ level: 'silent' }),
      auth: { authProvider, userRepository: support.stack.userRepository },
      workflowRepository: { workflowRepositoryService: support.repository },
      workflowRuns: { workflowRunService: support.runs },
      workflowDeployments: { workflowDeploymentService: support.deployments },
    });
    await app.ready();

    const inject = async (
      method: string,
      url: string,
      payload?: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await app.inject({
        method: method as 'GET' | 'POST',
        url,
        headers: payload === undefined
          ? { authorization: `Bearer ${API_KEY}` }
          : { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        payload: payload as Record<string, unknown> | string | undefined,
      });
      const raw = response as unknown as { statusCode: number; json: () => unknown };
      return { status: raw.statusCode, body: (raw.json?.() ?? {}) as Record<string, unknown> };
    };

    // --- the operator tenant + the REAL device node ------------------------
    const operator = await support.stack.userRepository.upsertByExternalId({
      externalId: 'v2-009-dogfooding-operator',
      displayName: 'V2-009 Dogfooding Operator',
    });
    const org = await support.stack.organizationRepository.create({ name: 'V2-009 Dogfooding Org' });
    await support.stack.membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
    const principal = { userId: operator.id };

    const device = registerNode(support.nodes, 'v2-009-dogfooding-device', 'desktop');
    line(`# device node registered through the real V2-004 protocol: platform=desktop location=device trust=trusted`);

    // --- the morning-briefing workflow: create + install (pin) -------------
    const createWorkflow = await inject('POST', `/organizations/${org.id}/workflow-repository/workflows`, {
      slug: 'morning-briefing',
      name: 'Morning Briefing',
      description: 'The V2-009 dogfooding workflow',
      visibility: 'private',
      content: JSON.parse(serializeWorkflowIrDocument(authorMorningBriefingDocument())),
      protocol: { irSchemaVersion: 'test-ir-1' },
    });
    if (createWorkflow.status !== 201) throw new Error(`workflow create failed: ${JSON.stringify(createWorkflow.body)}`);
    const workflowId = (createWorkflow.body.workflow as Record<string, unknown>).id as string;
    const versionId = (createWorkflow.body.initialVersion as Record<string, unknown>).id as string;

    const install = await inject('POST', `/organizations/${org.id}/workflow-repository/installations`, {
      workflowId,
      versionId,
    });
    if (install.status !== 201) throw new Error(`install failed: ${JSON.stringify(install.body)}`);
    const installationId = (install.body.installation as Record<string, unknown>).id as string;
    line(`# workflow created + installed (pinned immutable version 1) through the real V2-002 routes`);

    // ======================================================================
    // 1. THE SCHEDULED WORKFLOW (daily 09:00 Africa/Accra)
    // ======================================================================
    const createDeployment = await inject('POST', `/organizations/${org.id}/workflow-deployments/deployments`, {
      workflowId,
      versionId,
      installationId,
      name: 'morning-briefing-daily',
      placement: { placement: { required: 'device_preferred' }, privacy: { localOnly: false } },
    });
    if (createDeployment.status !== 201) throw new Error(`deployment create failed: ${JSON.stringify(createDeployment.body)}`);
    const scheduledDeploymentId = (createDeployment.body.deployment as Record<string, unknown>).id as string;

    const createSubscription = await inject(
      'POST',
      `/workflow-deployments/deployments/${scheduledDeploymentId}/subscriptions`,
      {
        kind: 'schedule',
        schedule: { kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '09:00' },
      },
    );
    if (createSubscription.status !== 201) throw new Error(`subscription create failed: ${JSON.stringify(createSubscription.body)}`);
    line(`# deployment 'morning-briefing-daily' created (device_preferred) with a DAILY 09:00 Africa/Accra schedule`);

    // Advance the injected clock past the next 09:00 Accra boundary (GMT+0).
    const now = clock.now();
    const base09 = Date.UTC(2026, 8, 1, 9, 0);
    const next09 = now < base09 ? base09 : base09 + Math.ceil((now - base09) / 86_400_000) * 86_400_000;
    clock.advance(next09 - now + 1_000);

    const tick = await inject('POST', `/organizations/${org.id}/workflow-deployments/tick`);
    if (tick.status !== 200) throw new Error(`tick failed: ${JSON.stringify(tick.body)}`);
    const scheduledDeliveryId = (tick.body.deliveriesDelivered as string[])[0];
    line(`# tick fired the 09:00 occurrence: deliveriesDelivered=1 occurrencesConsidered=${tick.body.occurrencesConsidered}`);

    const scheduledDelivery = (await inject('GET', `/workflow-deployments/deliveries/${scheduledDeliveryId}`)).body
      .delivery as Record<string, unknown>;
    line(`# scheduled delivery state=${scheduledDelivery.state} scheduledAt=${scheduledDelivery.scheduledAt} resolution=${scheduledDelivery.scheduleResolution}`);
    line(`# placement resolved: node=${scheduledDelivery.resolvedNodeId} placement=${scheduledDelivery.resolvedPlacement} rank=${scheduledDelivery.placementRank}`);

    // The run through the REAL V2-005 route (correlation + trigger identity).
    const scheduledRunId = scheduledDelivery.runId as string;
    const scheduledRun = (await inject('GET', `/workflow-runs/runs/${scheduledRunId}`)).body.run as Record<string, unknown>;
    line(`# run created through the real V2-005 boundary: state=${scheduledRun.state} trigger=${JSON.stringify(scheduledRun.trigger)}`);
    const runTrigger = scheduledRun.trigger as Record<string, unknown>;
    if (runTrigger.type !== 'schedule') throw new Error('expected a schedule trigger');
    if (scheduledDelivery.resolvedNodeId !== device.nodeId) throw new Error('expected the registered device as the resolved node');
    if (scheduledDelivery.placementRank !== 0) throw new Error('expected placement rank 0 (device_preferred primary)');

    // ======================================================================
    // 2. THE EVENT WORKFLOW (file.changed, typed schema, REAL file)
    // ======================================================================
    // A real file on the real filesystem (sandboxed temp dir).
    const sandboxDir = await mkdtemp(join(tmpdir(), 'v2-009-dogfooding-'));
    const briefingPath = join(sandboxDir, 'inbox', 'morning-briefing.md');
    await mkdir(join(sandboxDir, 'inbox'), { recursive: true });
    const briefingBytes = Buffer.from(
      'MORNING BRIEFING (2026-09-02)\n- inbox triage: 2 invoices processed\n- 1 approval pending\n',
      'utf8',
    );
    await writeFile(briefingPath, briefingBytes);
    const realDigest = sha256HexOf(briefingBytes);
    line(`# real event source file written: ${briefingPath} (sha-256 ${realDigest.slice(0, 16)}…)`);

    const createEventDeployment = await inject('POST', `/organizations/${org.id}/workflow-deployments/deployments`, {
      workflowId,
      versionId,
      installationId,
      name: 'briefing-on-file-change',
      placement: { placement: { required: 'device_preferred' }, privacy: { localOnly: false } },
    });
    const eventDeploymentId = (createEventDeployment.body.deployment as Record<string, unknown>).id as string;
    const createEventSubscription = await inject(
      'POST',
      `/workflow-deployments/deployments/${eventDeploymentId}/subscriptions`,
      {
        kind: 'event',
        eventPattern: {
          eventType: 'file.changed',
          source: device.nodeId,
          match: [{ field: 'path', value: briefingPath }],
        },
      },
    );
    if (createEventSubscription.status !== 201) throw new Error(`event subscription failed: ${JSON.stringify(createEventSubscription.body)}`);
    line(`# event subscription: file.changed sourced from the device, matching the real file path (typed schema)`);

    const deliver = await inject('POST', `/organizations/${org.id}/workflow-deployments/events`, {
      source: device.nodeId,
      eventId: 'morning-briefing-0001',
      eventType: 'file.changed',
      payload: { path: briefingPath, digest: realDigest },
    });
    if (deliver.status !== 201) throw new Error(`event delivery failed: ${JSON.stringify(deliver.body)}`);
    const eventDelivery = (deliver.body.deliveries as Record<string, unknown>[])[0]!;
    line(`# event delivered: matched 1 subscription, delivery state=${eventDelivery.state} run=${eventDelivery.runId}`);
    const eventRun = (await inject('GET', `/workflow-runs/runs/${eventDelivery.runId}`)).body.run as Record<string, unknown>;
    line(`# event/run correlation: the run's trigger identity = ${JSON.stringify(eventRun.trigger)}`);
    const eventRunTrigger = eventRun.trigger as Record<string, unknown>;
    if (eventRunTrigger.type !== 'file_event') throw new Error('expected a file_event trigger');
    if (eventRunTrigger.id !== `evt:${(deliver.body.event as Record<string, unknown>).id}:${(deliver.body.matchedSubscriptionIds as string[])[0]}`) {
      throw new Error('the run trigger identity must embed the inbox event identity');
    }
    if (eventDelivery.resolvedNodeId !== device.nodeId) throw new Error('expected the device as the event delivery node');

    // ======================================================================
    // 3. DUPLICATE SUPPRESSION
    // ======================================================================
    const duplicate = await inject('POST', `/organizations/${org.id}/workflow-deployments/events`, {
      source: device.nodeId,
      eventId: 'morning-briefing-0001',
      eventType: 'file.changed',
      payload: { path: briefingPath, digest: realDigest },
    });
    if (duplicate.status !== 200) throw new Error(`duplicate must converge (200), got ${duplicate.status}`);
    if (duplicate.body.created !== false) throw new Error('duplicate must report created=false');
    line(`# DUPLICATE event delivered again: HTTP ${duplicate.status} created=${duplicate.body.created} newDeliveries=${(duplicate.body.deliveries as unknown[]).length}`);

    const runsList = (await inject('GET', `/organizations/${org.id}/workflow-runs/runs`)).body.runs as Record<
      string,
      unknown
    >[];
    line(`# runs after the duplicate: exactly ${runsList.length} (1 scheduled + 1 event — NO second side effect)`);
    if (runsList.length !== 2) throw new Error(`expected exactly 2 runs, got ${runsList.length}`);

    // ======================================================================
    // 4. PLACEMENT BEHAVIOR — the offline-device recovery path
    // ======================================================================
    const offlineNodes = support.freshNodes();
    const offlineDeployments = support.makeDeployments(offlineNodes);
    const { deployment: offlineDeployment } = await offlineDeployments.createDeployment(principal, {
      organizationId: org.id,
      workflowId,
      versionId,
      installationId,
      name: 'briefing-offline-recovery',
      placement: { placement: { required: 'device_local' }, privacy: { localOnly: true } },
    });
    await offlineDeployments.createSubscription(principal, {
      deploymentId: offlineDeployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: new Date(clock.now() + 30_000).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z') },
      deliveryPolicy: { missWindowMs: 86_400_000, missedWindow: 'skip', maxAttempts: 10, backoffBaseMs: 1_000, backoffMaxMs: 8_000 },
    });
    clock.advance(60_000);
    const offlineTick1 = await offlineDeployments.tick(principal, { organizationId: org.id });
    const pendingId = offlineTick1.stillPending[0]!.deliveryId;
    const pendingDelivery = await offlineDeployments.getDelivery(principal, pendingId);
    line(`# offline device (isolated empty directory): delivery state=${pendingDelivery.state} attempts=${pendingDelivery.attempts.length} outcome=${pendingDelivery.attempts[0]!.outcome}`);
    if (pendingDelivery.state !== 'pending') throw new Error('expected pending while the device is offline');

    const recoveredDevice = registerNode(offlineNodes, 'v2-009-dogfooding-recovered', 'desktop');
    clock.advance(2_000);
    await offlineDeployments.tick(principal, { organizationId: org.id });
    const recoveredDelivery = await offlineDeployments.getDelivery(principal, pendingId);
    line(`# device recovered through the real protocol: delivery state=${recoveredDelivery.state} node=${recoveredDelivery.resolvedNodeId} run=${recoveredDelivery.runId !== null ? 'created' : 'none'}`);
    if (recoveredDelivery.state !== 'delivered' || recoveredDelivery.resolvedNodeId !== recoveredDevice.nodeId) {
      throw new Error('expected recovery to deliver on the recovered device');
    }

    // ======================================================================
    // 5. NEGATIVE — the disabled deployment
    // ======================================================================
    const { deployment: disabledDeployment } = await support.deployments.createDeployment(principal, {
      organizationId: org.id,
      workflowId,
      versionId,
      installationId,
      name: 'briefing-disabled',
      placement: { placement: { required: 'device_preferred' }, privacy: { localOnly: false } },
    });
    await support.deployments.createSubscription(principal, {
      deploymentId: disabledDeployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: new Date(clock.now() + 30_000).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z') },
    });
    await support.deployments.setDeploymentEnabled(principal, { deploymentId: disabledDeployment.id, enabled: false });
    clock.advance(60_000);
    const disabledTick = await support.deployments.tick(principal, { organizationId: org.id });
    line(`# disabled deployment: skippedDisabled=${disabledTick.deliveriesSkippedDisabled.length} delivered=${disabledTick.deliveriesDelivered.length} (enable/disable is real)`);
    if (disabledTick.deliveriesSkippedDisabled.length !== 1 || disabledTick.deliveriesDelivered.length !== 0) {
      throw new Error('expected the disabled deployment occurrence to be skipped');
    }

    line(`# PASS: scheduled workflow fired, event workflow delivered, duplicate suppressed, placement recorded + recovered`);

    await app.close();
    return [...TRANSCRIPT_LINES];
  } finally {
    await support.teardown();
  }
}

// ============================================================================
// Determinism: run twice, normalize run-scoped bookkeeping, compare
// ============================================================================

/** Normalize run-scoped bookkeeping (the V2-005/V2-006 precedent). */
function normalize(lines: string[]): string {
  const uuidMap = new Map<string, string>();
  const idMap = new Map<string, string>();
  let uuidCounter = 0;
  let idCounter = 0;
  return lines
    .join('\n')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (match) => {
      if (!uuidMap.has(match)) uuidMap.set(match, `<uuid-${(uuidCounter += 1)}>`);
      return uuidMap.get(match)!;
    })
    .replace(/\b(?:dep|sub|evt|dlv|run|node|wfr)_[0-9a-f]{6,}\b/g, (match) => {
      if (!idMap.has(match)) idMap.set(match, `<${match.split('_')[0]}-${(idCounter += 1)}>`);
      return idMap.get(match)!;
    })
    // The sandboxed temp-dir names (mkdtemp suffixes) are run-scoped.
    .replace(/v2-009-dogfooding-[A-Za-z0-9]{4,}/g, 'v2-009-dogfooding-<tmp>');
}

async function main(): Promise<void> {
  line('=== V2-009 dogfooding RUN 1 (fresh PGlite + fresh identity stack) ===');
  const run1 = await runExperiment();
  const normalized1 = normalize(run1);

  line('\n=== V2-009 dogfooding RUN 2 (fresh PGlite + fresh identity stack) ===');
  const run2 = await runExperiment();
  const normalized2 = normalize(run2);

  const identical = normalized1 === normalized2;
  // eslint-disable-next-line no-console
  console.log(`\ndeterminism: transcripts ${identical ? 'IDENTICAL after normalization' : 'DIVERGED'}`);
  if (!identical) {
    // eslint-disable-next-line no-console
    console.log('--- RUN 1 (normalized) ---');
    // eslint-disable-next-line no-console
    console.log(normalized1);
    // eslint-disable-next-line no-console
    console.log('--- RUN 2 (normalized) ---');
    // eslint-disable-next-line no-console
    console.log(normalized2);
    process.exitCode = 1;
    return;
  }
  // eslint-disable-next-line no-console
  console.log('\nDOGFOODING RESULT: PASS (deterministic across two fresh runs)');
}

await main();

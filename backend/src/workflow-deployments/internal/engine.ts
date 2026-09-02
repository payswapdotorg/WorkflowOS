/**
 * V2-009 — the trigger engine (the deterministic firing core).
 *
 * NOT a hidden autonomous workflow engine (constitution §19): the engine
 * only INSTANTIATES runs through the merged V2-005 requestRun boundary; it
 * never executes workflow steps, never starts/completes runs, never records
 * run evidence. It advances ONLY when driven (deliverEvent / tick — the
 * platform decides when to drive it; there is no ambient timer).
 *
 * Determinism: given the same database state, injected clock and node
 * directory state, every engine pass is byte-identical.
 *
 * Concurrency: every write is create-or-converge (deterministic identities
 * + UNIQUE surfaces + state-guarded transitions). Two concurrent triggers
 * of the same surface converge — one delivery, one run (V2-005's run-level
 * convergence is the second defense layer).
 */
import type {
  DeliveryPolicy,
  EventPattern,
  InboundEvent,
  RunTriggerType,
  ScheduleSpec,
  TickResult,
  TriggerDelivery,
  TriggerSubscription,
  WorkflowDeployment,
  WorkflowPrincipal,
} from '../types.js';
import { WorkflowDeploymentError } from '../types.js';
import { epochMsOf, formatUtcTimestamp, toUtcIsoString } from './clock.js';
import {
  backoffDelayMs,
  isWithinMissWindow,
} from './delivery-policy.js';
import {
  eventMatchesPattern,
  eventSchemaOf,
  eventTriggerTypeOf,
  validateEventPayload,
} from './event-schema.js';
import {
  canonicalJson,
  deliveryCommandId,
  deriveDeliveryId,
  deriveInboundEventId,
  eventTriggerId,
  eventTriggerKey,
  scheduleInputCommitments,
  scheduleTriggerId,
  scheduleTriggerKey,
} from './identity.js';
import { deploymentRequirementSetOf } from './placement.js';
import { nextOccurrenceAfter } from './schedule.js';
import {
  mapDeliveryRow,
  mapDeploymentRow,
  mapInboundEventRow,
  mapSubscriptionRow,
  type PgTriggerStore,
} from './pg-trigger-store.js';
import type { NodeDirectoryReadPort } from '../types.js';
import type {
  RequestRunResult,
  RunCommandEnvelope,
  RunCommandOutcome,
  WorkflowRunService,
} from '../../workflow-runs/index.js';

/** The mutable tick accumulator (frozen into TickResult on return). */
type MutableTickResult = {
  occurrencesConsidered: number;
  deliveriesCreated: TriggerDelivery[];
  deliveriesDelivered: string[];
  deliveriesConverged: string[];
  deliveriesMissed: string[];
  deliveriesSuperseded: string[];
  deliveriesSkippedDisabled: string[];
  deliveriesFailed: string[];
  stillPending: { readonly deliveryId: string; readonly retryAt: string }[];
};

export interface TriggerEngineDeps {
  readonly store: PgTriggerStore;
  readonly runs: WorkflowRunService;
  readonly nodes: NodeDirectoryReadPort;
  /** The injected clock (fixed-format UTC; never ambient). */
  readonly clock: () => string;
}

export class TriggerEngine {
  private readonly store: PgTriggerStore;
  private readonly runs: WorkflowRunService;
  private readonly nodes: NodeDirectoryReadPort;
  private readonly clock: () => string;

  constructor(deps: TriggerEngineDeps) {
    this.store = deps.store;
    this.runs = deps.runs;
    this.nodes = deps.nodes;
    this.clock = deps.clock;
  }

  // ==========================================================================
  // EVENT INGEST (deliverEvent) — the typed, deduplicated inbox entry point
  // ==========================================================================

  /**
   * Ingest one event (idempotent on (source, eventId)) and immediately
   * attempt delivery to every matching enabled subscription.
   */
  async deliverEvent(
    input: {
      readonly organizationId: string;
      readonly source: string;
      readonly eventId: string;
      readonly eventType: string;
      readonly occurredAt?: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<{
    readonly event: InboundEvent;
    readonly created: boolean;
    readonly matchedSubscriptionIds: readonly string[];
    readonly deliveries: readonly TriggerDelivery[];
  }> {
    const now = this.clock();
    if (typeof input.source !== 'string' || input.source.length === 0 || input.source.length > 128) {
      throw new WorkflowDeploymentError('EVENT_INVALID_REQUEST', 'source must be a non-empty string (the producer identity)');
    }
    if (typeof input.eventId !== 'string' || input.eventId.length === 0 || input.eventId.length > 128) {
      throw new WorkflowDeploymentError('EVENT_INVALID_REQUEST', 'eventId must be a non-empty string (the producer event identity)');
    }
    const validation = validateEventPayload(input.eventType, input.payload);
    if (!validation.ok) {
      // Unknown event TYPES are a vocabulary failure (distinct code); the
      // payload-shape failures are schema failures.
      if (eventSchemaOf(input.eventType) === null) {
        throw new WorkflowDeploymentError('EVENT_TYPE_UNKNOWN', 'the event type is not in the frozen registry vocabulary', input.eventType);
      }
      throw new WorkflowDeploymentError('EVENT_SCHEMA_INVALID', 'the event payload failed its typed schema', validation.detail);
    }
    const occurredAt = input.occurredAt === undefined ? now : toCanonical(input.occurredAt);

    const eventId = deriveInboundEventId(input.organizationId, input.source, input.eventId);
    const ingested = await this.store.insertEventOrConverge({
      id: eventId,
      organizationId: input.organizationId,
      eventId: input.eventId,
      eventType: input.eventType,
      source: input.source,
      occurredAt,
      receivedAt: now,
      payloadCommitment: validation.commitment,
    });
    const event: InboundEvent = {
      id: ingested.row.id,
      organizationId: ingested.row.organization_id,
      eventId: ingested.row.event_id,
      eventType: ingested.row.event_type,
      source: ingested.row.source,
      // Wire/database timestamps normalize to fixed-format UTC (PGlite
      // returns TIMESTAMPTZ as Date objects; the canonical string passes).
      occurredAt: toUtcIsoString(ingested.row.occurred_at),
      receivedAt: toUtcIsoString(ingested.row.received_at),
      payloadCommitment: ingested.row.payload_commitment,
    };

    if (!ingested.created) {
      // DUPLICATE EVENT: converged — no re-match, no new deliveries, no
      // second side effect (the REQUIRED duplicate-event regression).
      return { event, created: false, matchedSubscriptionIds: [], deliveries: [] };
    }

    // Match against the org's ENABLED event subscriptions (deterministic order).
    const subscriptions = (await this.store.listEventSubscriptionsInOrganization(input.organizationId))
      .map(mapSubscriptionRow)
      .filter((sub) => sub.enabled && sub.eventPattern !== null);
    const matched: TriggerSubscription[] = [];
    for (const sub of subscriptions) {
      const pattern = sub.eventPattern as EventPattern;
      if (eventMatchesPattern(event.eventType, event.source, input.payload, pattern)) {
        matched.push(sub);
      }
    }

    const deliveries: TriggerDelivery[] = [];
    for (const sub of matched) {
      const triggerKey = eventTriggerKey(event.id);
      const deliveryId = deriveDeliveryId(sub.id, triggerKey);
      const created = await this.store.insertDeliveryOrConverge({
        id: deliveryId,
        organizationId: input.organizationId,
        deploymentId: sub.deploymentId,
        subscriptionId: sub.id,
        kind: 'event',
        triggerKey,
        scheduledAt: null,
        scheduleResolution: null,
        createdAt: now,
      });
      const record = mapDeliveryRow(created.row);
      if (created.created) {
        const attempted = await this.attemptDelivery(record, {});
        deliveries.push(attempted);
      } else {
        deliveries.push(record); // already fired/converged (idempotent)
      }
    }

    return {
      event,
      created: true,
      matchedSubscriptionIds: matched.map((sub) => sub.id),
      deliveries,
    };
  }

  // ==========================================================================
  // THE TICK (advance schedules + retry pending deliveries)
  // ==========================================================================

  async tick(organizationId: string): Promise<TickResult> {
    const now = this.clock();
    const nowMs = epochMsOf(now);

    const result = {
      occurrencesConsidered: 0,
      deliveriesCreated: [] as TriggerDelivery[],
      deliveriesDelivered: [] as string[],
      deliveriesConverged: [] as string[],
      deliveriesMissed: [] as string[],
      deliveriesSuperseded: [] as string[],
      deliveriesSkippedDisabled: [] as string[],
      deliveriesFailed: [] as string[],
      stillPending: [] as { readonly deliveryId: string; readonly retryAt: string }[],
    };

    // --- 1. due schedule occurrences ------------------------------------------
    const scheduleSubs = (await this.store.listScheduleSubscriptionsInOrganization(organizationId))
      .map(mapSubscriptionRow);

    for (const sub of scheduleSubs) {
      const spec = sub.schedule as ScheduleSpec | null;
      if (spec === null) continue;
      const anchorMs = epochMsOf(sub.createdAt);
      const cursorMs = sub.cursor === null ? anchorMs : epochMsOf(sub.cursor);

      // Derive occurrences strictly after the cursor, up to now (the
      // anti-storm sweep: at most the LATEST due occurrence fires; older
      // ones are SUPERSEDED — honestly recorded, never back-filled).
      const due: { scheduledAt: string; resolution: 'normal' | 'gap_shifted' | 'ambiguous_first' }[] = [];
      let cursor = cursorMs;
      for (let guard = 0; guard < 1000; guard += 1) {
        const occurrence = nextOccurrenceAfter(spec, cursor, anchorMs);
        if (occurrence === null) break;
        const occurrenceMs = epochMsOf(occurrence.scheduledAt);
        if (occurrenceMs > nowMs) break;
        due.push(occurrence);
        cursor = occurrenceMs;
      }
      if (due.length === 0) continue;
      result.occurrencesConsidered += due.length;

      // The LATEST due occurrence is the firing candidate; older ones supersede.
      const latest = due[due.length - 1]!;
      for (const older of due.slice(0, -1)) {
        const triggerKey = scheduleTriggerKey(older.scheduledAt);
        const deliveryId = deriveDeliveryId(sub.id, triggerKey);
        const created = await this.store.insertDeliveryOrConverge({
          id: deliveryId,
          organizationId,
          deploymentId: sub.deploymentId,
          subscriptionId: sub.id,
          kind: 'schedule',
          triggerKey,
          scheduledAt: older.scheduledAt,
          scheduleResolution: older.resolution,
          createdAt: now,
        });
        if (created.created) {
          // Older due occurrences never fire (bounded catch-up): recorded
          // superseded with an honest attempt entry.
          const record = mapDeliveryRow(created.row);
          const superseded = await this.store.transitionDelivery(record.id, 'pending', {
            state: 'superseded',
            attempts: [
              ...record.attempts,
              {
                at: now,
                outcome: 'missed_window' as const,
                detail: `superseded by the newer occurrence ${latest.scheduledAt} (bounded catch-up: never a backlog)`,
              },
            ],
            retryAt: null,
            missedWindowApplied: null,
            resolvedNodeId: null,
            resolvedPlacement: null,
            placementRank: null,
            runId: null,
            failureCode: null,
            failureDetail: null,
            updatedAt: now,
          });
          if (superseded !== null) result.deliveriesSuperseded.push(superseded.id);
        }
      }

      // The latest occurrence: missed-window policy, then fire.
      const triggerKey = scheduleTriggerKey(latest.scheduledAt);
      const deliveryId = deriveDeliveryId(sub.id, triggerKey);
      const policy = sub.deliveryPolicy;
      const missed = !isWithinMissWindow(epochMsOf(latest.scheduledAt), nowMs, policy);

      const created = await this.store.insertDeliveryOrConverge({
        id: deliveryId,
        organizationId,
        deploymentId: sub.deploymentId,
        subscriptionId: sub.id,
        kind: 'schedule',
        triggerKey,
        scheduledAt: latest.scheduledAt,
        scheduleResolution: latest.resolution,
        createdAt: now,
      });
      const record = mapDeliveryRow(created.row);
      if (created.created) {
        result.deliveriesCreated.push(record);
      }

      if (missed && policy.missedWindow === 'skip') {
        // MISSED SCHEDULE (the required regression): the occurrence aged out.
        const transitioned = await this.store.transitionDelivery(record.id, 'pending', {
          state: 'missed',
          attempts: [
            ...record.attempts,
            {
              at: now,
              outcome: 'missed_window' as const,
              detail: `the occurrence ${latest.scheduledAt} exceeded the ${policy.missWindowMs}ms delivery window (missedWindow: skip)`,
            },
          ],
          retryAt: null,
          missedWindowApplied: 'skip',
          resolvedNodeId: null,
          resolvedPlacement: null,
          placementRank: null,
          runId: null,
          failureCode: null,
          failureDetail: null,
          updatedAt: now,
        });
        if (transitioned !== null) {
          result.deliveriesMissed.push(transitioned.id);
        } else {
          await this.convergeRecorded(record.id, result);
        }
      } else {
        const applied = missed ? ('catch_up_run_now' as const) : null;
        const attempted = await this.attemptDelivery(record, {
          missedWindowApplied: applied,
        });
        this.classifyAttempted(attempted, result);
      }

      // Advance the cursor to the last considered occurrence (the derivation
      // is strictly-after; missed/superseded occurrences never re-derive).
      await this.store.updateSubscriptionCursor({
        subscriptionId: sub.id,
        cursor: latest.scheduledAt,
        updatedAt: now,
      });
    }

    // --- 2. pending retries (placement-unavailable deliveries) ---------------
    const pending = await this.store.listPendingDeliveriesDueInOrganization(organizationId, now);
    for (const row of pending) {
      const record = mapDeliveryRow(row);
      const attempted = await this.attemptDelivery(record, {});
      this.classifyAttempted(attempted, result);
    }

    // --- 3. remaining pending (future retries) — honest report ---------------
    const stillPending = await this.store.listPendingDeliveriesDueInOrganization(
      organizationId,
      formatUtcTimestamp(4_102_444_800_000), // far-future sentinel: ALL pending
    );
    for (const row of stillPending) {
      result.stillPending.push({
        deliveryId: row.id,
        retryAt: row.retry_at === null ? String(row.created_at) : String(row.retry_at),
      });
    }

    return result;
  }

  // ==========================================================================
  // THE DELIVERY ATTEMPT (placement resolution → run creation, idempotent)
  // ==========================================================================

  private async attemptDelivery(
    record: TriggerDelivery,
    context: {
      readonly missedWindowApplied?: 'skip' | 'catch_up_run_now' | null;
    },
  ): Promise<TriggerDelivery> {
    const now = this.clock();
    const deployment = await this.loadDeployment(record.deploymentId);
    const subscription = await this.loadSubscription(record.subscriptionId);
    const policy: DeliveryPolicy = subscription.deliveryPolicy;
    const attempts = [...record.attempts];
    const attemptNumber = attempts.length + 1;

    // 1. Enable/disable semantics (user-visible state is a hard gate).
    if (!deployment.enabled || !subscription.enabled) {
      const transitioned = await this.store.transitionDelivery(record.id, 'pending', {
        state: 'skipped_disabled',
        attempts: [
          ...attempts,
          {
            at: now,
            outcome: 'disabled' as const,
            detail: !deployment.enabled ? 'the deployment is disabled' : 'the subscription is disabled',
          },
        ],
        retryAt: null,
        missedWindowApplied: context.missedWindowApplied ?? null,
        resolvedNodeId: null,
        resolvedPlacement: null,
        placementRank: null,
        runId: null,
        failureCode: null,
        failureDetail: null,
        updatedAt: now,
      });
      return transitioned === null ? (await this.reread(record.id)) ?? record : mapFresh(transitioned);
    }

    // 2. Placement resolution (the merged V2-004 matcher — the only
    //    placement authority; capability-free run-level locality/trust set).
    const requirement = deploymentRequirementSetOf(deployment.placement);
    const match = await this.nodes.matchNodes(requirement);
    const eligible = match.evaluations.filter((e) => e.eligible);
    if (eligible.length === 0) {
      // PLACEMENT FAILURE / OFFLINE DEVICE: bounded deterministic retry.
      if (attemptNumber >= policy.maxAttempts) {
        const transitioned = await this.store.transitionDelivery(record.id, 'pending', {
          state: 'failed',
          attempts: [
            ...attempts,
            {
              at: now,
              outcome: 'exhausted' as const,
              detail: `no eligible node after ${attemptNumber} attempts (matcher reasons: ${summarizeReasons(match)})`,
            },
          ],
          retryAt: null,
          missedWindowApplied: context.missedWindowApplied ?? null,
          resolvedNodeId: null,
          resolvedPlacement: null,
          placementRank: null,
          runId: null,
          failureCode: 'TRIGGER_PLACEMENT_UNAVAILABLE',
          failureDetail: `no eligible node for placement ${canonicalJson(deployment.placement.placement)} after ${attemptNumber} attempts`,
          updatedAt: now,
        });
        return transitioned === null ? (await this.reread(record.id)) ?? record : mapFresh(transitioned);
      }
      const delay = backoffDelayMs(attemptNumber, policy);
      const retryAt = formatUtcTimestamp(epochMsOf(now) + delay);
      const transitioned = await this.store.transitionDelivery(record.id, 'pending', {
        state: 'pending',
        attempts: [
          ...attempts,
          {
            at: now,
            outcome: 'placement_unavailable' as const,
            detail: `no eligible node (retry ${attemptNumber}/${policy.maxAttempts} at +${delay}ms; matcher reasons: ${summarizeReasons(match)})`,
          },
        ],
        retryAt,
        missedWindowApplied: context.missedWindowApplied ?? null,
        resolvedNodeId: null,
        resolvedPlacement: null,
        placementRank: null,
        runId: null,
        failureCode: null,
        failureDetail: null,
        updatedAt: now,
      });
      return transitioned === null ? (await this.reread(record.id)) ?? record : mapFresh(transitioned);
    }

    // Deterministic choice: the matcher's own preference order
    // (placementRank, nodeId) — the first eligible evaluation.
    const chosen = eligible[0]!;

    // 3. Run creation — the merged V2-005 requestRun boundary ONLY.
    //
    // The event context (type + payload commitment) is ALWAYS loaded from
    // the durable inbox row — the first attempt and every retry therefore
    // derive byte-identical trigger/input surfaces (run-level convergence
    // holds across retries; a divergent second run is unrepresentable).
    const principal: WorkflowPrincipal = { userId: deployment.createdByUserId };
    let triggerType: RunTriggerType;
    let triggerId: string;
    let inputCommitments: readonly string[];
    if (record.kind === 'schedule') {
      triggerType = 'schedule';
      triggerId = scheduleTriggerId(subscription.id, record.triggerKey.slice('occ:'.length));
      inputCommitments = scheduleInputCommitments(record.triggerKey.slice('occ:'.length));
    } else {
      const eventRow = await this.store.findEventById(record.triggerKey.slice('evt:'.length));
      if (eventRow === null) {
        const transitioned = await this.store.transitionDelivery(record.id, 'pending', {
          state: 'failed',
          attempts: [
            ...attempts,
            {
              at: now,
              outcome: 'rejected' as const,
              detail: 'the inbox event row is no longer readable (durable history violated)',
            },
          ],
          retryAt: null,
          missedWindowApplied: context.missedWindowApplied ?? null,
          resolvedNodeId: chosen.nodeId,
          resolvedPlacement: chosen.satisfiedPlacement,
          placementRank: chosen.placementRank,
          runId: null,
          failureCode: 'TRIGGER_RUN_REQUEST_REJECTED',
          failureDetail: 'the inbox event row is no longer readable',
          updatedAt: now,
        });
        return transitioned === null ? (await this.reread(record.id)) ?? record : mapFresh(transitioned);
      }
      const event = mapInboundEventRow(eventRow);
      triggerType = eventTriggerTypeOf(event.eventType);
      triggerId = eventTriggerId(event.id, subscription.id);
      inputCommitments = [event.payloadCommitment];
    }
    const envelope: RunCommandEnvelope = {
      commandId: deliveryCommandId(record.id, attemptNumber),
      correlationId: `trg-${record.id}`,
    };

    try {
      const outcome: RunCommandOutcome<RequestRunResult> = await this.runs.requestRun(principal, envelope, {
        organizationId: deployment.organizationId,
        workflowId: deployment.workflowId,
        versionId: deployment.versionId,
        installationId: deployment.installationId,
        trigger: { type: triggerType, id: triggerId },
        inputCommitments,
      });
      const runId = outcome.result.run.id;
      const delivered = outcome.result.created;
      // executed=false → the same command converged (a prior identical
      // attempt); created=false → the run already existed (duplicate trigger
      // surface). Both are honest convergence.
      const state = delivered ? 'delivered' : 'converged';
      const transitioned = await this.store.transitionDelivery(record.id, 'pending', {
        state,
        attempts: [
          ...attempts,
          {
            at: now,
            outcome: delivered ? ('run_requested' as const) : ('run_converged' as const),
            detail: delivered ? `run ${runId} created` : `converged on the existing run ${runId} (duplicate trigger surface)`,
          },
        ],
        retryAt: null,
        missedWindowApplied: context.missedWindowApplied ?? null,
        resolvedNodeId: chosen.nodeId,
        resolvedPlacement: chosen.satisfiedPlacement,
        placementRank: chosen.placementRank,
        runId,
        failureCode: null,
        failureDetail: null,
        updatedAt: now,
      });
      return transitioned === null ? (await this.reread(record.id)) ?? record : mapFresh(transitioned);
    } catch (error) {
      // A typed V2-005 rejection is deterministic validation — retrying will
      // not help: fail the delivery honestly with the propagated code.
      const code = (error as { code?: string }).code ?? 'UNKNOWN';
      const message = error instanceof Error ? error.message : String(error);
      const transitioned = await this.store.transitionDelivery(record.id, 'pending', {
        state: 'failed',
        attempts: [
          ...attempts,
          {
            at: now,
            outcome: 'rejected' as const,
            detail: `the run boundary rejected the request (${code}: ${message})`,
          },
        ],
        retryAt: null,
        missedWindowApplied: context.missedWindowApplied ?? null,
        resolvedNodeId: chosen.nodeId,
        resolvedPlacement: chosen.satisfiedPlacement,
        placementRank: chosen.placementRank,
        runId: null,
        failureCode: 'TRIGGER_RUN_REQUEST_REJECTED',
        failureDetail: `${code}: ${message}`,
        updatedAt: now,
      });
      return transitioned === null ? (await this.reread(record.id)) ?? record : mapFresh(transitioned);
    }
  }

  // ==========================================================================
  // helpers
  // ==========================================================================

  private async loadDeployment(deploymentId: string): Promise<WorkflowDeployment> {
    const row = await this.store.findDeploymentById(deploymentId);
    if (row === null) {
      throw new WorkflowDeploymentError('DEPLOYMENT_NOT_FOUND', 'the deployment no longer exists', deploymentId);
    }
    return mapDeploymentRow(row);
  }

  private async loadSubscription(subscriptionId: string): Promise<TriggerSubscription> {
    const row = await this.store.findSubscriptionById(subscriptionId);
    if (row === null) {
      throw new WorkflowDeploymentError('SUBSCRIPTION_NOT_FOUND', 'the subscription no longer exists', subscriptionId);
    }
    return mapSubscriptionRow(row);
  }

  private async reread(deliveryId: string): Promise<TriggerDelivery | null> {
    const row = await this.store.findDeliveryById(deliveryId);
    return row === null ? null : mapDeliveryRow(row);
  }

  private async convergeRecorded(deliveryId: string, result: MutableTickResult): Promise<void> {
    const row = await this.store.findDeliveryById(deliveryId);
    if (row === null) return;
    const state = row.state;
    if (state === 'missed') result.deliveriesMissed.push(row.id);
    else if (state === 'superseded') result.deliveriesSuperseded.push(row.id);
    else if (state === 'delivered') result.deliveriesDelivered.push(row.id);
    else if (state === 'converged') result.deliveriesConverged.push(row.id);
    else if (state === 'failed') result.deliveriesFailed.push(row.id);
    else if (state === 'skipped_disabled') result.deliveriesSkippedDisabled.push(row.id);
  }

  private classifyAttempted(delivery: TriggerDelivery, result: MutableTickResult): void {
    switch (delivery.state) {
      case 'delivered':
        result.deliveriesDelivered.push(delivery.id);
        break;
      case 'converged':
        result.deliveriesConverged.push(delivery.id);
        break;
      case 'missed':
        result.deliveriesMissed.push(delivery.id);
        break;
      case 'superseded':
        result.deliveriesSuperseded.push(delivery.id);
        break;
      case 'skipped_disabled':
        result.deliveriesSkippedDisabled.push(delivery.id);
        break;
      case 'failed':
        result.deliveriesFailed.push(delivery.id);
        break;
      case 'pending':
        break;
    }
  }
}

function summarizeReasons(match: { readonly evaluations: readonly { readonly reasons: readonly { readonly code: string }[] }[] }): string {
  const codes = new Set<string>();
  for (const evaluation of match.evaluations) {
    for (const reason of evaluation.reasons) codes.add(reason.code);
  }
  return [...codes].sort().join(',') || 'no-nodes-registered';
}

/** Map a freshly transitioned row (already normalized). */
function mapFresh(row: Parameters<typeof mapDeliveryRow>[0]): TriggerDelivery {
  return mapDeliveryRow(row);
}
function toCanonical(timestamp: unknown): string {
  if (typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    return timestamp;
  }
  throw new WorkflowDeploymentError(
    'EVENT_INVALID_REQUEST',
    'occurredAt must be a fixed-format UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ)',
    String(timestamp),
  );
}

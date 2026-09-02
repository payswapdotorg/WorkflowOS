/**
 * V2-009 — the PostgreSQL trigger store (the persistence authority's adapter).
 *
 * Structure (the pg-run-store precedent): every write is create-or-converge
 * on the deterministic identity surfaces; the only sanctioned delivery
 * UPDATE is the state-guarded transition (terminal states are immutable by
 * database trigger — 0062); reads map rows to the typed records with
 * fixed-format UTC timestamps. No in-memory trigger state is a source of
 * truth (PostgreSQL is the authority; PGlite is the same boundary in
 * test/dev).
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  DeliveryAttempt,
  DeliveryPolicy,
  EventPattern,
  InboundEvent,
  ScheduleSpec,
  TriggerDelivery,
  TriggerDeliveryState,
  TriggerSubscription,
  WorkflowDeployment,
} from '../types.js';
import { toUtcIsoString } from './clock.js';

// ============================================================================
// Row shapes (snake_case in PostgreSQL, mapped to the typed records)
// ============================================================================

export interface DeploymentRow {
  [column: string]: unknown;
  id: string;
  organization_id: string;
  workflow_id: string;
  version_id: string;
  installation_id: string | null;
  name: string;
  description: string | null;
  placement: unknown;
  privacy: unknown;
  min_trust_tier: string | null;
  enabled: boolean;
  enabled_at: unknown;
  disabled_at: unknown;
  created_by_user_id: string;
  created_at: unknown;
  updated_at: unknown;
}

export interface SubscriptionRow {
  [column: string]: unknown;
  id: string;
  organization_id: string;
  deployment_id: string;
  kind: 'schedule' | 'event';
  schedule: unknown;
  event_pattern: unknown;
  delivery_policy: unknown;
  enabled: boolean;
  cursor: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface InboundEventRow {
  [column: string]: unknown;
  id: string;
  organization_id: string;
  event_id: string;
  event_type: string;
  source: string;
  occurred_at: unknown;
  received_at: unknown;
  payload_commitment: string;
}

export interface DeliveryRow {
  [column: string]: unknown;
  id: string;
  organization_id: string;
  deployment_id: string;
  subscription_id: string;
  kind: 'schedule' | 'event';
  trigger_key: string;
  state: TriggerDeliveryState;
  scheduled_at: unknown;
  schedule_resolution: string | null;
  missed_window_applied: string | null;
  attempts: unknown;
  retry_at: unknown;
  resolved_node_id: string | null;
  resolved_placement: string | null;
  placement_rank: number | null;
  run_id: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  created_at: unknown;
  updated_at: unknown;
}

// ============================================================================
// Row → typed-record mappers (pure; timestamps normalized to fixed UTC)
// ============================================================================

export function mapDeploymentRow(row: DeploymentRow): WorkflowDeployment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workflowId: row.workflow_id,
    versionId: row.version_id,
    installationId: row.installation_id,
    name: row.name,
    description: row.description,
    placement: {
      placement: row.placement as WorkflowDeployment['placement']['placement'],
      privacy: row.privacy as WorkflowDeployment['placement']['privacy'],
      minTrustTier: (row.min_trust_tier ?? undefined) as WorkflowDeployment['placement']['minTrustTier'],
    },
    enabled: row.enabled,
    enabledAt: row.enabled_at === null ? null : toUtcIsoString(row.enabled_at),
    disabledAt: row.disabled_at === null ? null : toUtcIsoString(row.disabled_at),
    createdByUserId: row.created_by_user_id,
    createdAt: toUtcIsoString(row.created_at),
    updatedAt: toUtcIsoString(row.updated_at),
  };
}

export function mapSubscriptionRow(row: SubscriptionRow): TriggerSubscription {
  return {
    id: row.id,
    organizationId: row.organization_id,
    deploymentId: row.deployment_id,
    kind: row.kind,
    schedule: (row.schedule ?? null) as ScheduleSpec | null,
    eventPattern: (row.event_pattern ?? null) as EventPattern | null,
    deliveryPolicy: row.delivery_policy as DeliveryPolicy,
    enabled: row.enabled,
    cursor: row.cursor,
    createdAt: toUtcIsoString(row.created_at),
    updatedAt: toUtcIsoString(row.updated_at),
  };
}

export function mapInboundEventRow(row: InboundEventRow): InboundEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventId: row.event_id,
    eventType: row.event_type,
    source: row.source,
    occurredAt: toUtcIsoString(row.occurred_at),
    receivedAt: toUtcIsoString(row.received_at),
    payloadCommitment: row.payload_commitment,
  };
}

export function mapDeliveryRow(row: DeliveryRow): TriggerDelivery {
  const attempts: unknown[] = Array.isArray(row.attempts) ? row.attempts : [];
  return {
    id: row.id,
    organizationId: row.organization_id,
    deploymentId: row.deployment_id,
    subscriptionId: row.subscription_id,
    kind: row.kind,
    triggerKey: row.trigger_key,
    state: row.state,
    scheduledAt: row.scheduled_at === null ? null : toUtcIsoString(row.scheduled_at),
    scheduleResolution: (row.schedule_resolution ?? null) as TriggerDelivery['scheduleResolution'],
    missedWindowApplied: (row.missed_window_applied ?? null) as TriggerDelivery['missedWindowApplied'],
    attempts: attempts as DeliveryAttempt[],
    retryAt: row.retry_at === null ? null : toUtcIsoString(row.retry_at),
    resolvedNodeId: row.resolved_node_id,
    resolvedPlacement: (row.resolved_placement ?? null) as TriggerDelivery['resolvedPlacement'],
    placementRank: row.placement_rank === null ? null : Number(row.placement_rank),
    runId: row.run_id,
    failure:
      row.failure_code === null
        ? null
        : {
            code: row.failure_code as NonNullable<TriggerDelivery['failure']>['code'],
            detail: row.failure_detail,
          },
    createdAt: toUtcIsoString(row.created_at),
    updatedAt: toUtcIsoString(row.updated_at),
  };
}

// ============================================================================
// The store
// ============================================================================

const DEPLOYMENT_COLUMNS = `id, organization_id, workflow_id, version_id, installation_id,
  name, description, placement, privacy, min_trust_tier, enabled, enabled_at,
  disabled_at, created_by_user_id, created_at, updated_at`;
const SUBSCRIPTION_COLUMNS = `id, organization_id, deployment_id, kind, schedule,
  event_pattern, delivery_policy, enabled, cursor, created_at, updated_at`;
const EVENT_COLUMNS = `id, organization_id, event_id, event_type, source,
  occurred_at, received_at, payload_commitment`;
const DELIVERY_COLUMNS = `id, organization_id, deployment_id, subscription_id, kind,
  trigger_key, state, scheduled_at, schedule_resolution, missed_window_applied,
  attempts, retry_at, resolved_node_id, resolved_placement, placement_rank,
  run_id, failure_code, failure_detail, created_at, updated_at`;

export class PgTriggerStore {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  // --- deployments ------------------------------------------------------------

  /** Create-or-converge on the deterministic pin surface. */
  async insertDeploymentOrConverge(row: {
    readonly id: string;
    readonly organizationId: string;
    readonly workflowId: string;
    readonly versionId: string;
    readonly installationId: string | null;
    readonly name: string;
    readonly description: string | null;
    readonly placement: unknown;
    readonly privacy: unknown;
    readonly minTrustTier: string | null;
    readonly enabled: boolean;
    readonly enabledAt: string | null;
    readonly createdByUserId: string;
    readonly createdAt: string;
  }): Promise<{ row: DeploymentRow; created: boolean }> {
    const inserted = await this.db.query<DeploymentRow>(
      `INSERT INTO wfos_v2_deployments
         (id, organization_id, workflow_id, version_id, installation_id, name,
          description, placement, privacy, min_trust_tier, enabled, enabled_at,
          created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11,
               $12, $13, $14, $14)
       ON CONFLICT (organization_id, workflow_id, version_id, name)
       DO NOTHING
       RETURNING ${DEPLOYMENT_COLUMNS}`,
      [
        row.id,
        row.organizationId,
        row.workflowId,
        row.versionId,
        row.installationId,
        row.name,
        row.description,
        JSON.stringify(row.placement),
        JSON.stringify(row.privacy),
        row.minTrustTier,
        row.enabled,
        row.enabledAt,
        row.createdByUserId,
        row.createdAt,
      ],
    );
    if (inserted.rows[0] !== undefined) return { row: inserted.rows[0], created: true };
    const converged = await this.db.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_COLUMNS} FROM wfos_v2_deployments
       WHERE organization_id = $1 AND workflow_id = $2 AND version_id = $3 AND name = $4`,
      [row.organizationId, row.workflowId, row.versionId, row.name],
    );
    if (converged.rows[0] === undefined) {
      throw new Error('workflow-deployments store: deployment converged but is unreadable');
    }
    return { row: converged.rows[0], created: false };
  }

  async findDeploymentById(deploymentId: string): Promise<DeploymentRow | null> {
    const result = await this.db.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_COLUMNS} FROM wfos_v2_deployments WHERE id = $1`,
      [deploymentId],
    );
    return result.rows[0] ?? null;
  }

  async listDeploymentsInOrganization(organizationId: string): Promise<DeploymentRow[]> {
    const result = await this.db.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_COLUMNS} FROM wfos_v2_deployments
       WHERE organization_id = $1 ORDER BY created_at ASC, id ASC`,
      [organizationId],
    );
    return result.rows;
  }

  async updateDeploymentEnabled(row: {
    readonly deploymentId: string;
    readonly enabled: boolean;
    readonly at: string;
  }): Promise<DeploymentRow | null> {
    const result = await this.db.query<DeploymentRow>(
      `UPDATE wfos_v2_deployments
       SET enabled = $2,
           enabled_at = CASE WHEN $2 THEN $3 ELSE enabled_at END,
           disabled_at = CASE WHEN $2 THEN disabled_at ELSE $3 END,
           updated_at = $3
       WHERE id = $1
       RETURNING ${DEPLOYMENT_COLUMNS}`,
      [row.deploymentId, row.enabled, row.at],
    );
    return result.rows[0] ?? null;
  }

  // --- subscriptions ----------------------------------------------------------

  /** Create-or-converge on the deterministic spec surface. */
  async insertSubscriptionOrConverge(row: {
    readonly id: string;
    readonly organizationId: string;
    readonly deploymentId: string;
    readonly kind: 'schedule' | 'event';
    readonly schedule: unknown;
    readonly eventPattern: unknown;
    readonly deliveryPolicy: unknown;
    readonly enabled: boolean;
    readonly cursor: string | null;
    readonly createdAt: string;
  }): Promise<{ row: SubscriptionRow; created: boolean }> {
    const inserted = await this.db.query<SubscriptionRow>(
      `INSERT INTO wfos_v2_trigger_subscriptions
         (id, organization_id, deployment_id, kind, schedule, event_pattern,
          delivery_policy, enabled, cursor, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $10)
       ON CONFLICT (deployment_id, kind, schedule, event_pattern)
       DO NOTHING
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [
        row.id,
        row.organizationId,
        row.deploymentId,
        row.kind,
        row.schedule === null ? null : JSON.stringify(row.schedule),
        row.eventPattern === null ? null : JSON.stringify(row.eventPattern),
        JSON.stringify(row.deliveryPolicy),
        row.enabled,
        row.cursor,
        row.createdAt,
      ],
    );
    if (inserted.rows[0] !== undefined) return { row: inserted.rows[0], created: true };
    const converged = await this.db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM wfos_v2_trigger_subscriptions
       WHERE deployment_id = $1 AND kind = $2 AND schedule IS NOT DISTINCT FROM $3::jsonb
         AND event_pattern IS NOT DISTINCT FROM $4::jsonb`,
      [
        row.deploymentId,
        row.kind,
        row.schedule === null ? null : JSON.stringify(row.schedule),
        row.eventPattern === null ? null : JSON.stringify(row.eventPattern),
      ],
    );
    if (converged.rows[0] === undefined) {
      throw new Error('workflow-deployments store: subscription converged but is unreadable');
    }
    return { row: converged.rows[0], created: false };
  }

  async findSubscriptionById(subscriptionId: string): Promise<SubscriptionRow | null> {
    const result = await this.db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM wfos_v2_trigger_subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    return result.rows[0] ?? null;
  }

  async listSubscriptionsForDeployment(deploymentId: string): Promise<SubscriptionRow[]> {
    const result = await this.db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM wfos_v2_trigger_subscriptions
       WHERE deployment_id = $1 ORDER BY created_at ASC, id ASC`,
      [deploymentId],
    );
    return result.rows;
  }

  async listScheduleSubscriptionsInOrganization(organizationId: string): Promise<SubscriptionRow[]> {
    const result = await this.db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM wfos_v2_trigger_subscriptions
       WHERE organization_id = $1 AND kind = 'schedule'
       ORDER BY created_at ASC, id ASC`,
      [organizationId],
    );
    return result.rows;
  }

  async listEventSubscriptionsInOrganization(organizationId: string): Promise<SubscriptionRow[]> {
    const result = await this.db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM wfos_v2_trigger_subscriptions
       WHERE organization_id = $1 AND kind = 'event'
       ORDER BY created_at ASC, id ASC`,
      [organizationId],
    );
    return result.rows;
  }

  async updateSubscriptionCursor(row: {
    readonly subscriptionId: string;
    readonly cursor: string;
    readonly updatedAt: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE wfos_v2_trigger_subscriptions
       SET cursor = $2, updated_at = $3 WHERE id = $1`,
      [row.subscriptionId, row.cursor, row.updatedAt],
    );
  }

  async updateSubscriptionEnabled(row: {
    readonly subscriptionId: string;
    readonly enabled: boolean;
    readonly updatedAt: string;
  }): Promise<SubscriptionRow | null> {
    const result = await this.db.query<SubscriptionRow>(
      `UPDATE wfos_v2_trigger_subscriptions
       SET enabled = $2, updated_at = $3
       WHERE id = $1
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [row.subscriptionId, row.enabled, row.updatedAt],
    );
    return result.rows[0] ?? null;
  }

  // --- the event inbox --------------------------------------------------------

  /** Create-or-converge on the producer identity surface (event dedup). */
  async insertEventOrConverge(row: {
    readonly id: string;
    readonly organizationId: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly source: string;
    readonly occurredAt: string;
    readonly receivedAt: string;
    readonly payloadCommitment: string;
  }): Promise<{ row: InboundEventRow; created: boolean }> {
    const inserted = await this.db.query<InboundEventRow>(
      `INSERT INTO wfos_v2_inbound_events
         (id, organization_id, event_id, event_type, source, occurred_at,
          received_at, payload_commitment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (organization_id, source, event_id)
       DO NOTHING
       RETURNING ${EVENT_COLUMNS}`,
      [
        row.id,
        row.organizationId,
        row.eventId,
        row.eventType,
        row.source,
        row.occurredAt,
        row.receivedAt,
        row.payloadCommitment,
      ],
    );
    if (inserted.rows[0] !== undefined) return { row: inserted.rows[0], created: true };
    const converged = await this.db.query<InboundEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM wfos_v2_inbound_events
       WHERE organization_id = $1 AND source = $2 AND event_id = $3`,
      [row.organizationId, row.source, row.eventId],
    );
    if (converged.rows[0] === undefined) {
      throw new Error('workflow-deployments store: event converged but is unreadable');
    }
    return { row: converged.rows[0], created: false };
  }

  async findEventById(eventInternalId: string): Promise<InboundEventRow | null> {
    const result = await this.db.query<InboundEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM wfos_v2_inbound_events WHERE id = $1`,
      [eventInternalId],
    );
    return result.rows[0] ?? null;
  }

  // --- deliveries -------------------------------------------------------------

  /** Create-or-converge on the deterministic fire surface. */
  async insertDeliveryOrConverge(row: {
    readonly id: string;
    readonly organizationId: string;
    readonly deploymentId: string;
    readonly subscriptionId: string;
    readonly kind: 'schedule' | 'event';
    readonly triggerKey: string;
    readonly scheduledAt: string | null;
    readonly scheduleResolution: 'normal' | 'gap_shifted' | 'ambiguous_first' | null;
    readonly createdAt: string;
  }): Promise<{ row: DeliveryRow; created: boolean }> {
    const inserted = await this.db.query<DeliveryRow>(
      `INSERT INTO wfos_v2_trigger_deliveries
         (id, organization_id, deployment_id, subscription_id, kind, trigger_key,
          state, scheduled_at, schedule_resolution, missed_window_applied,
          attempts, retry_at, resolved_node_id, resolved_placement,
          placement_rank, run_id, failure_code, failure_detail, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, NULL, '[]'::jsonb,
               NULL, NULL, NULL, NULL, NULL, NULL, NULL, $9, $9)
       ON CONFLICT (subscription_id, trigger_key)
       DO NOTHING
       RETURNING ${DELIVERY_COLUMNS}`,
      [
        row.id,
        row.organizationId,
        row.deploymentId,
        row.subscriptionId,
        row.kind,
        row.triggerKey,
        row.scheduledAt,
        row.scheduleResolution,
        row.createdAt,
      ],
    );
    if (inserted.rows[0] !== undefined) return { row: inserted.rows[0], created: true };
    const converged = await this.db.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM wfos_v2_trigger_deliveries
       WHERE subscription_id = $1 AND trigger_key = $2`,
      [row.subscriptionId, row.triggerKey],
    );
    if (converged.rows[0] === undefined) {
      throw new Error('workflow-deployments store: delivery converged but is unreadable');
    }
    return { row: converged.rows[0], created: false };
  }

  async findDeliveryById(deliveryId: string): Promise<DeliveryRow | null> {
    const result = await this.db.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM wfos_v2_trigger_deliveries WHERE id = $1`,
      [deliveryId],
    );
    return result.rows[0] ?? null;
  }

  async listDeliveriesForDeployment(deploymentId: string): Promise<DeliveryRow[]> {
    const result = await this.db.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM wfos_v2_trigger_deliveries
       WHERE deployment_id = $1 ORDER BY created_at ASC, id ASC`,
      [deploymentId],
    );
    return result.rows;
  }

  /** Pending deliveries whose retry is due (the tick retry sweep). */
  async listPendingDeliveriesDueInOrganization(
    organizationId: string,
    dueBeforeIso: string,
  ): Promise<DeliveryRow[]> {
    const result = await this.db.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM wfos_v2_trigger_deliveries
       WHERE organization_id = $1 AND state = 'pending'
         AND (retry_at IS NULL OR retry_at <= $2)
       ORDER BY created_at ASC, id ASC`,
      [organizationId, dueBeforeIso],
    );
    return result.rows;
  }

  /**
   * The state-guarded delivery transition (the only sanctioned UPDATE): the
   * caller must have observed `expectedState`; a concurrent terminal write
   * makes this a no-op (returns null → the caller converges by re-reading).
   */
  async transitionDelivery(
    deliveryId: string,
    expectedState: TriggerDeliveryState,
    patch: {
      readonly state: TriggerDeliveryState;
      readonly attempts: readonly DeliveryAttempt[];
      readonly retryAt: string | null;
      readonly missedWindowApplied: 'skip' | 'catch_up_run_now' | null;
      readonly resolvedNodeId: string | null;
      readonly resolvedPlacement: string | null;
      readonly placementRank: number | null;
      readonly runId: string | null;
      readonly failureCode: string | null;
      readonly failureDetail: string | null;
      readonly updatedAt: string;
    },
  ): Promise<DeliveryRow | null> {
    const result = await this.db.query<DeliveryRow>(
      `UPDATE wfos_v2_trigger_deliveries
       SET state = $3, attempts = $4::jsonb, retry_at = $5,
           missed_window_applied = $6, resolved_node_id = $7,
           resolved_placement = $8, placement_rank = $9, run_id = $10,
           failure_code = $11, failure_detail = $12, updated_at = $13
       WHERE id = $1 AND state = $2
       RETURNING ${DELIVERY_COLUMNS}`,
      [
        deliveryId,
        expectedState,
        patch.state,
        JSON.stringify(patch.attempts),
        patch.retryAt,
        patch.missedWindowApplied,
        patch.resolvedNodeId,
        patch.resolvedPlacement,
        patch.placementRank,
        patch.runId,
        patch.failureCode,
        patch.failureDetail,
        patch.updatedAt,
      ],
    );
    return result.rows[0] ?? null;
  }
}

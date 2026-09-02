/**
 * V2-009 — the deterministic identity + digest derivations (PURE).
 *
 * Same discipline as the merged V2-002/V2-005 identity layers: the same
 * authoritative inputs always produce byte-identical identities — no
 * randomness, no clock, no process-local state ever enters identity.
 * Duplicate deployment/subscription/event/delivery submissions therefore
 * converge structurally (divergent duplicate rows are unrepresentable — the
 * migration's UNIQUE constraints are the persistence-layer defense in
 * depth).
 *
 * The canonical-JSON helper is deliberately module-internal (the recorded
 * W1/W2A finding: canonical-JSON helpers stay module-internal per domain).
 */
import { createHash } from 'node:crypto';
import { WorkflowDeploymentError } from '../types.js';

/** SHA-256 hex (64 lowercase chars) over the UTF-8 bytes of `input`. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Canonical JSON: UTF-8 JSON with deterministic object-key ordering
 * (recursive), no insignificant whitespace. Array order is PRESERVED unless
 * the owning derivation explicitly normalizes.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => serializeCanonical(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(obj[key])}`);
    return `{${members.join(',')}}`;
  }
  // undefined at top level — canonicalize as null (JSON has no undefined).
  return 'null';
}

function hex16(input: string): string {
  return sha256Hex(input).slice(0, 16);
}

// ============================================================================
// Deterministic record identities (the convergence surfaces)
// ============================================================================

/** Deployment identity: (organization, workflow, version, name). */
export function deriveDeploymentId(
  organizationId: string,
  workflowId: string,
  versionId: string,
  name: string,
): string {
  return `dep_${hex16(
    canonicalJson({ organizationId, workflowId, versionId, name: name.trim().toLowerCase() }),
  )}`;
}

/**
 * Subscription identity: (deployment, kind, canonical spec). Weekly
 * daysOfWeek sets are normalized (sorted unique) before identity so
 * presentation-only permutations converge.
 */
export function deriveSubscriptionId(
  deploymentId: string,
  kind: 'schedule' | 'event',
  spec: unknown,
): string {
  return `sub_${hex16(canonicalJson({ deploymentId, kind, spec: canonicalizeSpec(spec) }))}`;
}

function canonicalizeSpec(spec: unknown): unknown {
  if (typeof spec !== 'object' || spec === null) return spec;
  const record = spec as Record<string, unknown>;
  if (Array.isArray(record.daysOfWeek)) {
    const days = Array.from(new Set((record.daysOfWeek as readonly number[]).slice().sort((a, b) => a - b)));
    return { ...record, daysOfWeek: days };
  }
  return record;
}

/** Inbound-event identity: (organization, source, external event id) — the dedup surface. */
export function deriveInboundEventId(organizationId: string, source: string, eventId: string): string {
  return `evt_${hex16(canonicalJson({ organizationId, source, eventId }))}`;
}

/** Delivery identity: (subscription, trigger key) — the fire idempotency surface. */
export function deriveDeliveryId(subscriptionId: string, triggerKey: string): string {
  return `dlv_${hex16(canonicalJson({ subscriptionId, triggerKey }))}`;
}

// ============================================================================
// Run-trigger identities (V2-005's RunTrigger { type, id } surface — the
// run-level duplicate-delivery convergence key)
// ============================================================================

/** The schedule delivery trigger key: the occurrence instant IS the identity. */
export function scheduleTriggerKey(occurrenceIso: string): string {
  return `occ:${occurrenceIso}`;
}

/** The event delivery trigger key: the inbox event id IS the identity. */
export function eventTriggerKey(inboundEventId: string): string {
  return `evt:${inboundEventId}`;
}

/** The run trigger id for a schedule fire: subscription + occurrence (one run per occurrence). */
export function scheduleTriggerId(subscriptionId: string, occurrenceIso: string): string {
  return `sch:${subscriptionId}:${occurrenceIso}`;
}

/** The run trigger id for an event fire: event + subscription (one run per pair). */
export function eventTriggerId(inboundEventId: string, subscriptionId: string): string {
  return `evt:${inboundEventId}:${subscriptionId}`;
}

/**
 * The V2-005 command id for a delivery attempt: (delivery, attempt number) —
 * a retry that observes the same attempt number reuses the same command id
 * and therefore converges in the durable command log (exactly-once).
 */
export function deliveryCommandId(deliveryId: string, attemptNumber: number): string {
  return `trgcmd-${deliveryId}-${attemptNumber}`;
}

// ============================================================================
// Input identities (the run's one-way input commitments — V2-005 contract)
// ============================================================================

/** The canonical input commitment of an event delivery: the payload commitment. */
export function eventInputCommitments(payloadCommitment: string): string[] {
  return [payloadCommitment];
}

/** The canonical input commitment of a schedule delivery: the occurrence identity. */
export function scheduleInputCommitments(occurrenceIso: string): string[] {
  return [sha256Hex(`schedule-occurrence:${occurrenceIso}`)];
}

// ============================================================================
// Id-format validation (fail-closed; typed)
// ============================================================================

/** Validate a command id for the V2-005 envelope (typed rejection). */
export function assertCommandId(commandId: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/.test(commandId)) {
    throw new WorkflowDeploymentError(
      'TRIGGER_COMMAND_ID_INVALID',
      'the command id must be 8..128 chars of [a-z0-9._:-] starting alnum',
      commandId,
    );
  }
}

/** Validate a correlation id for the V2-005 envelope (typed rejection). */
export function assertCorrelationId(correlationId: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/.test(correlationId)) {
    throw new WorkflowDeploymentError(
      'TRIGGER_COMMAND_CORRELATION_ID_INVALID',
      'the correlation id must be 8..128 chars of [a-z0-9._:-] starting alnum',
      correlationId,
    );
  }
}

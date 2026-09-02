/**
 * V2-009 — typed event schemas: the per-registry-event payload schemas,
 * fail-closed ingest validation, subscription pattern validation, typed
 * matching, and the registry event-name → V2-005 run trigger-type map.
 *
 * The closed rule set (constitution §11 + V2-CTRL-003):
 *   - event TYPES are the frozen registry names, verbatim — no minted names;
 *   - each event type has a TYPED schema (declared fields + types +
 *     requiredness); ingest validates payloads against it (fail-closed);
 *   - extra payload fields are tolerated (forward compatibility) but can
 *     never be referenced by subscription matches (fail-closed against
 *     typos: a match must reference a DECLARED field with a DECLARED type);
 *   - matching is exact typed equality — no coercion, no wildcards;
 *   - the trigger-type map is total over the registry event vocabulary and
 *     lands only on V2-005's frozen RUN_TRIGGER_TYPES (consumed verbatim).
 */
import { WorkflowDeploymentError, type EventFieldMatch, type EventPattern, type EventSchema, type RunTriggerType } from '../types.js';
import { canonicalJson, sha256Hex } from './identity.js';
import { REGISTRY_EVENT_NAMES } from './registry-vocabulary.js';

// ============================================================================
// The typed event schemas (one per registry event name)
// ============================================================================

function schema(
  eventType: string,
  fields: [string, 'string' | 'number' | 'boolean', boolean][],
): EventSchema {
  return {
    eventType,
    fields: fields.map(([field, type, required]) => ({ field, type, required })),
  };
}

/**
 * The typed event schemas for the frozen registry event vocabulary.
 *
 * Policy: identity/correlation fields are REQUIRED (they are the event's
 * addressable facts); context fields are optional typed strings. No field
 * ever carries secret material by schema (constitution §16 — payloads are
 * typed metadata, and the store keeps only one-way commitments).
 */
export const EVENT_SCHEMAS: readonly EventSchema[] = [
  // workflow lifecycle
  schema('workflow.run.requested', [['runId', 'string', true], ['workflowId', 'string', false]]),
  schema('workflow.run.started', [['runId', 'string', true], ['workflowId', 'string', false]]),
  schema('workflow.run.paused', [['runId', 'string', true]]),
  schema('workflow.run.resumed', [['runId', 'string', true]]),
  schema('workflow.run.completed', [['runId', 'string', true], ['workflowId', 'string', false]]),
  schema('workflow.run.failed', [['runId', 'string', true], ['workflowId', 'string', false]]),
  schema('workflow.step.started', [['runId', 'string', true], ['stepId', 'string', true]]),
  schema('workflow.step.completed', [['runId', 'string', true], ['stepId', 'string', true]]),
  // execution lifecycle
  schema('capability.invocation.requested', [['runId', 'string', true], ['capability', 'string', false]]),
  schema('capability.invocation.completed', [['runId', 'string', true], ['capability', 'string', false]]),
  schema('observation.recorded', [['runId', 'string', false], ['subject', 'string', false]]),
  schema('verification.completed', [['runId', 'string', false], ['subject', 'string', false]]),
  schema('execution.attestation.issued', [['runId', 'string', true], ['attesterKeyId', 'string', false]]),
  schema('execution.attestation.verified', [['runId', 'string', true], ['attesterKeyId', 'string', false]]),
  schema('execution.proof.updated', [['proofId', 'string', true]]),
  // device events
  schema('device.connected', [['nodeId', 'string', true], ['platformClass', 'string', false]]),
  schema('device.disconnected', [['nodeId', 'string', true]]),
  // communication events
  schema('phone.call.received', [['callId', 'string', true], ['caller', 'string', false]]),
  schema('phone.call.ended', [['callId', 'string', true]]),
  schema('messaging.message.received', [['messageId', 'string', true], ['channel', 'string', false], ['sender', 'string', false]]),
  schema('notification.received', [['app', 'string', false], ['kind', 'string', false]]),
  // file events
  schema('file.created', [['path', 'string', true], ['digest', 'string', false]]),
  schema('file.changed', [['path', 'string', true], ['digest', 'string', false]]),
  // application events
  schema('application.opened', [['application', 'string', true], ['documentPath', 'string', false]]),
  // social threshold events
  schema('social.post.engagement.threshold_crossed', [
    ['postId', 'string', true],
    ['metric', 'string', true],
    ['threshold', 'number', true],
  ]),
  // deployment lifecycle
  schema('workflow.deployment.enabled', [['deploymentId', 'string', true]]),
  schema('workflow.deployment.disabled', [['deploymentId', 'string', true]]),
];

const SCHEMA_BY_TYPE = new Map<string, EventSchema>(EVENT_SCHEMAS.map((s) => [s.eventType, s]));

/** The typed schema of a registry event name (null = unknown to the registry). */
export function eventSchemaOf(eventType: string): EventSchema | null {
  if (!REGISTRY_EVENT_NAMES.has(eventType)) return null;
  return SCHEMA_BY_TYPE.get(eventType) ?? null;
}

// ============================================================================
// Ingest payload validation (fail-closed, typed)
// ============================================================================

export type PayloadValidation =
  | { readonly ok: true; readonly commitment: string }
  | { readonly ok: false; readonly detail: string };

/** Field-value bounds (typed metadata; bounded by contract). */
const MAX_FIELDS = 32;
const MAX_STRING_LENGTH = 512;

/**
 * Validate a payload against the event type's typed schema and derive the
 * one-way canonical commitment (privacy: the payload is never persisted raw).
 */
export function validateEventPayload(eventType: string, payload: unknown): PayloadValidation {
  const eventSchema = eventSchemaOf(eventType);
  if (eventSchema === null) {
    return { ok: false, detail: `unknown event type "${eventType}" (not in the frozen registry)` };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, detail: 'the payload must be a JSON object of typed fields' };
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > MAX_FIELDS) {
    return { ok: false, detail: `the payload exceeds the ${MAX_FIELDS}-field bound` };
  }
  for (const field of eventSchema.fields) {
    const value = record[field.field];
    if (value === undefined) {
      if (field.required) {
        return { ok: false, detail: `required field "${field.field}" is absent` };
      }
      continue;
    }
    if (value === null) {
      return { ok: false, detail: `field "${field.field}" is null (typed fields are never null)` };
    }
    if (typeof value !== field.type) {
      return { ok: false, detail: `field "${field.field}" must be ${field.type} (got ${typeof value})` };
    }
    if (field.type === 'string' && (value as string).length > MAX_STRING_LENGTH) {
      return { ok: false, detail: `field "${field.field}" exceeds the ${MAX_STRING_LENGTH}-char bound` };
    }
  }
  return { ok: true, commitment: payloadCommitmentOf(eventType, record) };
}

/** sha-256 over the canonical typed payload (module-internal discipline). */
export function payloadCommitmentOf(eventType: string, payload: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ eventType, payload: sortKeys(payload) }));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) out[key] = sortKeys(record[key]);
    }
    return out;
  }
  return value;
}

// ============================================================================
// Subscription pattern validation (fail-closed, typed)
// ============================================================================

/** Validate an event pattern (fail-closed against unknown types/fields/types). */
export function validateEventPattern(pattern: unknown): EventPattern {
  if (typeof pattern !== 'object' || pattern === null) {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_EVENT_PATTERN_INVALID',
      'the event pattern must be an object',
    );
  }
  const record = pattern as Record<string, unknown>;
  const eventType = record.eventType;
  if (typeof eventType !== 'string' || !REGISTRY_EVENT_NAMES.has(eventType)) {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_EVENT_TYPE_UNKNOWN',
      'eventType must be a canonical registry event name',
      typeof eventType === 'string' ? eventType : JSON.stringify(eventType),
    );
  }
  const eventSchema = eventSchemaOf(eventType);
  if (eventSchema === null) {
    // Unreachable (REGISTRY_EVENT_NAMES ⊆ schemas), fail closed anyway.
    throw new WorkflowDeploymentError('SUBSCRIPTION_EVENT_TYPE_UNKNOWN', 'no typed schema for the event', eventType);
  }

  let source: string | undefined;
  if (record.source !== undefined) {
    if (typeof record.source !== 'string' || record.source.length === 0 || record.source.length > 128) {
      throw new WorkflowDeploymentError(
        'SUBSCRIPTION_EVENT_PATTERN_INVALID',
        'source must be a non-empty string (the exact event-source identity)',
        JSON.stringify(record.source),
      );
    }
    source = record.source;
  }

  let match: EventFieldMatch[] | undefined;
  if (record.match !== undefined) {
    if (!Array.isArray(record.match) || record.match.length === 0) {
      throw new WorkflowDeploymentError(
        'SUBSCRIPTION_EVENT_PATTERN_INVALID',
        'match must be a non-empty array of typed field matches',
      );
    }
    if (record.match.length > MAX_FIELDS) {
      throw new WorkflowDeploymentError(
        'SUBSCRIPTION_EVENT_PATTERN_INVALID',
        `match exceeds the ${MAX_FIELDS}-field bound`,
      );
    }
    const seen = new Set<string>();
    const parsed: EventFieldMatch[] = [];
    for (const entry of record.match) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new WorkflowDeploymentError(
          'SUBSCRIPTION_EVENT_PATTERN_INVALID',
          'each match entry must be { field, value }',
        );
      }
      const m = entry as Record<string, unknown>;
      if (typeof m.field !== 'string' || !('value' in m)) {
        throw new WorkflowDeploymentError(
          'SUBSCRIPTION_EVENT_PATTERN_INVALID',
          'each match entry must declare field and value',
        );
      }
      const declared = eventSchema.fields.find((f) => f.field === m.field);
      if (declared === undefined) {
        throw new WorkflowDeploymentError(
          'SUBSCRIPTION_EVENT_MATCH_INVALID',
          `match field "${String(m.field)}" is not declared by the "${eventType}" typed schema`,
          String(m.field),
        );
      }
      const value: unknown = m.value;
      if (value === undefined || value === null || typeof value !== declared.type) {
        throw new WorkflowDeploymentError(
          'SUBSCRIPTION_EVENT_MATCH_INVALID',
          `match field "${String(m.field)}" expects a ${declared.type} value`,
        );
      }
      const typedValue = value as string | number | boolean;
      if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
        throw new WorkflowDeploymentError(
          'SUBSCRIPTION_EVENT_MATCH_INVALID',
          `match field "${String(m.field)}" exceeds the ${MAX_STRING_LENGTH}-char bound`,
        );
      }
      if (seen.has(String(m.field))) {
        throw new WorkflowDeploymentError(
          'SUBSCRIPTION_EVENT_PATTERN_INVALID',
          `duplicate match field "${String(m.field)}"`,
        );
      }
      seen.add(String(m.field));
      parsed.push({ field: String(m.field), value: typedValue });
    }
    match = parsed;
  }

  const result: EventPattern =
    source === undefined && match === undefined
      ? { eventType }
      : source !== undefined && match !== undefined
        ? { eventType, source, match }
        : source !== undefined
          ? { eventType, source }
          : { eventType, match: match! };
  return result;
}

// ============================================================================
// Typed matching (exact equality; no coercion, no wildcards)
// ============================================================================

/** Does an (already schema-validated) event match the subscription pattern? */
export function eventMatchesPattern(
  eventType: string,
  source: string,
  payload: Readonly<Record<string, unknown>>,
  pattern: EventPattern,
): boolean {
  if (eventType !== pattern.eventType) return false;
  if (pattern.source !== undefined && source !== pattern.source) return false;
  if (pattern.match !== undefined) {
    for (const matcher of pattern.match) {
      const value = payload[matcher.field];
      if (value === undefined) return false; // fail-closed: absent never matches
      if (typeof value !== typeof matcher.value) return false;
      if (value !== matcher.value) return false; // strict typed equality
    }
  }
  return true;
}

// ============================================================================
// The registry event-name → V2-005 run trigger-type map (total, frozen)
// ============================================================================

const TRIGGER_TYPE_BY_EVENT_GROUP: ReadonlyArray<[readonly string[], RunTriggerType]> = [
  [
    ['file.created', 'file.changed'],
    'file_event',
  ],
  [
    ['application.opened'],
    'application_event',
  ],
  [
    ['messaging.message.received', 'phone.call.received', 'phone.call.ended'],
    'communication_event',
  ],
  [
    ['device.connected', 'device.disconnected', 'notification.received'],
    'device_event',
  ],
  [
    ['social.post.engagement.threshold_crossed'],
    'social_threshold_event',
  ],
];

/** The V2-005 run trigger type for a registry event name (workflow lifecycle default). */
export function eventTriggerTypeOf(eventType: string): RunTriggerType {
  for (const [names, triggerType] of TRIGGER_TYPE_BY_EVENT_GROUP) {
    if (names.includes(eventType)) return triggerType;
  }
  // Every remaining registry event is a workflow/execution lifecycle fact.
  return 'workflow_lifecycle_event';
}

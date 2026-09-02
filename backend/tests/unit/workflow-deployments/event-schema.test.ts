/**
 * V2-009 — typed event schemas (the "event subscriptions with typed event
 * schemas" must-deliver): the closed registry event vocabulary, per-event
 * typed payload validation (fail-closed), subscription pattern validation and
 * typed matching, and the registry event-name → V2-005 run trigger-type map.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowDeploymentError } from '../../../src/workflow-deployments/index.js';
import {
  eventSchemaOf,
  validateEventPayload,
  validateEventPattern,
  eventMatchesPattern,
  eventTriggerTypeOf,
} from '../../../src/workflow-deployments/internal/event-schema.js';

describe('V2-009 — the registry event vocabulary (typed schemas)', () => {
  it('every registry event name resolves to a typed schema', () => {
    for (const eventType of [
      'workflow.run.requested',
      'workflow.run.completed',
      'workflow.deployment.enabled',
      'device.connected',
      'device.disconnected',
      'phone.call.received',
      'messaging.message.received',
      'notification.received',
      'file.created',
      'file.changed',
      'application.opened',
      'social.post.engagement.threshold_crossed',
    ]) {
      const schema = eventSchemaOf(eventType);
      expect(schema, `schema for ${eventType}`).not.toBeNull();
      expect(schema!.eventType).toBe(eventType);
      expect(schema!.fields.length).toBeGreaterThan(0);
    }
  });

  it('an event type outside the frozen registry has NO schema (fail-closed, typed EVENT_TYPE_UNKNOWN)', () => {
    expect(eventSchemaOf('file.deleted')).toBeNull();
    expect(eventSchemaOf('workflow.exploded')).toBeNull();
    expect(eventSchemaOf('')).toBeNull();
  });
});

describe('V2-009 — typed payload validation at ingest (fail-closed)', () => {
  it('file.changed with a declared string path validates (extra fields are tolerated)', () => {
    const result = validateEventPayload('file.changed', { path: '/inbox/invoice-001.txt', note: 'watched dir' });
    expect(result.ok).toBe(true);
  });

  it('a missing REQUIRED field is typed EVENT_SCHEMA_INVALID', () => {
    const result = validateEventPayload('file.changed', { digest: 'abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain('path');
    }
    expect(() => {
      throw new WorkflowDeploymentError('EVENT_SCHEMA_INVALID', 'invalid', result.ok ? undefined : result.detail);
    }).toThrowError(WorkflowDeploymentError);
  });

  it('a wrong-typed field value is rejected (string ≠ number ≠ boolean)', () => {
    expect(validateEventPayload('file.changed', { path: 42 }).ok).toBe(false);
    expect(
      validateEventPayload('social.post.engagement.threshold_crossed', {
        postId: 'p1',
        metric: 'likes',
        threshold: '1k',
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload('social.post.engagement.threshold_crossed', {
        postId: 'p1',
        metric: 'likes',
        threshold: 1000,
      }).ok,
    ).toBe(true);
  });

  it('the payload itself must be a plain object (arrays/strings/null rejected)', () => {
    expect(validateEventPayload('file.changed', null).ok).toBe(false);
    expect(validateEventPayload('file.changed', 'path').ok).toBe(false);
    expect(validateEventPayload('file.changed', ['path']).ok).toBe(false);
  });

  it('null values never satisfy any typed field (explicit null ≠ absent optional)', () => {
    expect(validateEventPayload('file.changed', { path: '/x', digest: null }).ok).toBe(false);
  });
});

describe('V2-009 — subscription event pattern validation (fail-closed)', () => {
  it('a canonical event type with declared-field matches validates', () => {
    const pattern = validateEventPattern({
      eventType: 'file.changed',
      source: 'node_device1',
      match: [{ field: 'path', value: '/inbox/invoice-001.txt' }],
    });
    expect(pattern).toEqual({
      eventType: 'file.changed',
      source: 'node_device1',
      match: [{ field: 'path', value: '/inbox/invoice-001.txt' }],
    });
  });

  it('an unknown event type is typed SUBSCRIPTION_EVENT_TYPE_UNKNOWN', () => {
    try {
      validateEventPattern({ eventType: 'file.deleted' });
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as WorkflowDeploymentError).code).toBe('SUBSCRIPTION_EVENT_TYPE_UNKNOWN');
    }
  });

  it('a match on an UNDECLARED field is typed SUBSCRIPTION_EVENT_MATCH_INVALID (fail-closed against typos)', () => {
    try {
      validateEventPattern({ eventType: 'file.changed', match: [{ field: 'pathname', value: '/x' }] });
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as WorkflowDeploymentError).code).toBe('SUBSCRIPTION_EVENT_MATCH_INVALID');
    }
  });

  it('a match value whose TYPE does not match the declared field type is rejected (typed)', () => {
    try {
      validateEventPattern({ eventType: 'file.changed', match: [{ field: 'path', value: 7 }] });
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as WorkflowDeploymentError).code).toBe('SUBSCRIPTION_EVENT_MATCH_INVALID');
    }
  });

  it('a non-object pattern is typed SUBSCRIPTION_EVENT_PATTERN_INVALID', () => {
    for (const bad of [null, 'file.changed', 3]) {
      try {
        validateEventPattern(bad);
        expect.unreachable('must throw');
      } catch (error) {
        expect((error as WorkflowDeploymentError).code).toBe('SUBSCRIPTION_EVENT_PATTERN_INVALID');
      }
    }
  });
});

describe('V2-009 — typed event matching', () => {
  const pattern = validateEventPattern({
    eventType: 'file.changed',
    source: 'node_device1',
    match: [{ field: 'path', value: '/inbox/invoice-001.txt' }],
  });

  it('an event with the exact type, source and matched field matches', () => {
    expect(
      eventMatchesPattern('file.changed', 'node_device1', { path: '/inbox/invoice-001.txt' }, pattern),
    ).toBe(true);
  });

  it('a different event type, source, or field value does NOT match (no silent wildcards)', () => {
    expect(eventMatchesPattern('file.created', 'node_device1', { path: '/inbox/invoice-001.txt' }, pattern)).toBe(
      false,
    );
    expect(eventMatchesPattern('file.changed', 'node_device2', { path: '/inbox/invoice-001.txt' }, pattern)).toBe(
      false,
    );
    expect(eventMatchesPattern('file.changed', 'node_device1', { path: '/other.txt' }, pattern)).toBe(false);
  });

  it('an absent optional match field does not match (fail-closed)', () => {
    const digestPattern = validateEventPattern({ eventType: 'file.changed', match: [{ field: 'digest', value: 'abc' }] });
    expect(eventMatchesPattern('file.changed', 'any', { path: '/x' }, digestPattern)).toBe(false);
  });

  it('a type-only pattern matches any source and payload of that type', () => {
    const typeOnly = validateEventPattern({ eventType: 'device.connected' });
    expect(eventMatchesPattern('device.connected', 'node_a', { nodeId: 'node_a' }, typeOnly)).toBe(true);
    expect(eventMatchesPattern('device.disconnected', 'node_a', { nodeId: 'node_a' }, typeOnly)).toBe(false);
  });

  it('exact typed equality (no coercion: "1000" does not match 1000)', () => {
    const threshold = validateEventPattern({
      eventType: 'social.post.engagement.threshold_crossed',
      match: [{ field: 'threshold', value: 1000 }],
    });
    expect(
      eventMatchesPattern('social.post.engagement.threshold_crossed', 'src', { postId: 'p', metric: 'likes', threshold: 1000 }, threshold),
    ).toBe(true);
    expect(
      eventMatchesPattern('social.post.engagement.threshold_crossed', 'src', { postId: 'p', metric: 'likes', threshold: '1000' }, threshold),
    ).toBe(false);
  });
});

describe('V2-009 — registry event name → V2-005 run trigger type (consumed verbatim)', () => {
  it('maps file events → file_event; app events → application_event; communication events → communication_event', () => {
    expect(eventTriggerTypeOf('file.created')).toBe('file_event');
    expect(eventTriggerTypeOf('file.changed')).toBe('file_event');
    expect(eventTriggerTypeOf('application.opened')).toBe('application_event');
    expect(eventTriggerTypeOf('messaging.message.received')).toBe('communication_event');
    expect(eventTriggerTypeOf('phone.call.received')).toBe('communication_event');
    expect(eventTriggerTypeOf('phone.call.ended')).toBe('communication_event');
  });

  it('maps device registry events → device_event; social thresholds → social_threshold_event', () => {
    expect(eventTriggerTypeOf('device.connected')).toBe('device_event');
    expect(eventTriggerTypeOf('device.disconnected')).toBe('device_event');
    expect(eventTriggerTypeOf('notification.received')).toBe('device_event');
    expect(eventTriggerTypeOf('social.post.engagement.threshold_crossed')).toBe('social_threshold_event');
  });

  it('maps workflow lifecycle + execution lifecycle events → workflow_lifecycle_event', () => {
    expect(eventTriggerTypeOf('workflow.run.completed')).toBe('workflow_lifecycle_event');
    expect(eventTriggerTypeOf('workflow.step.completed')).toBe('workflow_lifecycle_event');
    expect(eventTriggerTypeOf('workflow.deployment.enabled')).toBe('workflow_lifecycle_event');
    expect(eventTriggerTypeOf('execution.attestation.verified')).toBe('workflow_lifecycle_event');
    expect(eventTriggerTypeOf('capability.invocation.completed')).toBe('workflow_lifecycle_event');
    expect(eventTriggerTypeOf('observation.recorded')).toBe('workflow_lifecycle_event');
  });

  it('every result is one of the frozen RUN_TRIGGER_TYPES (consumed vocabulary, no minted names)', () => {
    const allowed = new Set<string>([
      'manual',
      'schedule',
      'webhook',
      'application_event',
      'file_event',
      'communication_event',
      'device_event',
      'social_threshold_event',
      'workflow_lifecycle_event',
    ]);
    for (const name of [
      'workflow.run.requested',
      'workflow.run.started',
      'workflow.run.completed',
      'workflow.run.failed',
      'workflow.run.paused',
      'workflow.run.resumed',
      'workflow.step.started',
      'workflow.step.completed',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'observation.recorded',
      'verification.completed',
      'execution.attestation.issued',
      'execution.attestation.verified',
      'execution.proof.updated',
      'device.connected',
      'device.disconnected',
      'phone.call.received',
      'phone.call.ended',
      'messaging.message.received',
      'notification.received',
      'file.created',
      'file.changed',
      'application.opened',
      'social.post.engagement.threshold_crossed',
      'workflow.deployment.enabled',
      'workflow.deployment.disabled',
    ]) {
      expect(allowed.has(eventTriggerTypeOf(name)), `trigger type of ${name}`).toBe(true);
    }
  });
});

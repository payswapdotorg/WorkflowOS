/**
 * V2-009 — deterministic identity derivations (PURE; the V2-002/V2-005
 * discipline): the same authoritative inputs always produce byte-identical
 * identities — no randomness, no clock, no process-local state. Duplicate
 * deployment/subscription/event/delivery submissions therefore converge
 * STRUCTURALLY (the migration's UNIQUE constraints are the persistence-layer
 * defense in depth).
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  sha256Hex,
  deriveDeploymentId,
  deriveSubscriptionId,
  deriveInboundEventId,
  deriveDeliveryId,
  scheduleTriggerKey,
  eventTriggerKey,
  scheduleTriggerId,
  eventTriggerId,
  deliveryCommandId,
} from '../../../src/workflow-deployments/internal/identity.js';

describe('V2-009 — canonical JSON + SHA-256 (module-internal, deterministic)', () => {
  it('canonical JSON orders object keys recursively and strips insignificant whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it('undefined-valued keys are dropped (canonical, not JSON.stringify quirks)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('sha256Hex is the lowercase hex digest', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('V2-009 — deterministic record identities', () => {
  it('deployment id: derived from (org, workflow, version, name) — stable + prefixed', () => {
    const a = deriveDeploymentId('org-1', 'wf-1', 'ver-1', 'daily-triage');
    const b = deriveDeploymentId('org-1', 'wf-1', 'ver-1', 'daily-triage');
    expect(a).toBe(b);
    expect(a).toMatch(/^dep_[0-9a-f]{16}$/);
    // any authoritative input divergence diverges the identity
    expect(deriveDeploymentId('org-2', 'wf-1', 'ver-1', 'daily-triage')).not.toBe(a);
    expect(deriveDeploymentId('org-1', 'wf-1', 'ver-1', 'nightly-triage')).not.toBe(a);
  });

  it('subscription id: derived from (deployment, kind, canonical spec) — spec-order insensitive where canonical', () => {
    const schedule = { kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '09:00' } as const;
    const a = deriveSubscriptionId('dep-1', 'schedule', schedule);
    const b = deriveSubscriptionId('dep-1', 'schedule', schedule);
    expect(a).toBe(b);
    expect(a).toMatch(/^sub_[0-9a-f]{16}$/);
    // weekly day sets are canonicalized (sorted unique) before identity
    const w1 = deriveSubscriptionId('dep-1', 'schedule', {
      kind: 'weekly',
      timezone: 'UTC',
      timeOfDay: '08:00',
      daysOfWeek: [1, 3, 5],
    });
    const w2 = deriveSubscriptionId('dep-1', 'schedule', {
      kind: 'weekly',
      timezone: 'UTC',
      timeOfDay: '08:00',
      daysOfWeek: [5, 1, 3, 1],
    });
    expect(w1).toBe(w2);
    // a different spec diverges
    expect(
      deriveSubscriptionId('dep-1', 'schedule', { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' }),
    ).not.toBe(a);
    // an event subscription diverges from a schedule subscription
    const e = deriveSubscriptionId('dep-1', 'event', { eventType: 'file.changed' });
    expect(e).not.toBe(a);
    expect(e).toMatch(/^sub_[0-9a-f]{16}$/);
  });

  it('inbound event id: derived from (org, source, external event id) — the dedup surface', () => {
    const a = deriveInboundEventId('org-1', 'node_device1', 'filechange-0001');
    const b = deriveInboundEventId('org-1', 'node_device1', 'filechange-0001');
    expect(a).toBe(b);
    expect(a).toMatch(/^evt_[0-9a-f]{16}$/);
    // same external id from a different source is a DIFFERENT event
    expect(deriveInboundEventId('org-1', 'node_device2', 'filechange-0001')).not.toBe(a);
    // a different external id from the same source is a DIFFERENT event
    expect(deriveInboundEventId('org-1', 'node_device1', 'filechange-0002')).not.toBe(a);
  });

  it('delivery id: derived from (subscription, trigger key) — the fire idempotency surface', () => {
    const a = deriveDeliveryId('sub-1', 'occ:2026-09-02T09:00:00.000Z');
    const b = deriveDeliveryId('sub-1', 'occ:2026-09-02T09:00:00.000Z');
    expect(a).toBe(b);
    expect(a).toMatch(/^dlv_[0-9a-f]{16}$/);
    expect(deriveDeliveryId('sub-1', 'occ:2026-09-03T09:00:00.000Z')).not.toBe(a);
    expect(deriveDeliveryId('sub-2', 'occ:2026-09-02T09:00:00.000Z')).not.toBe(a);
  });
});

describe('V2-009 — run-trigger identities (RunTrigger {type,id} surface)', () => {
  it('schedule trigger key/id: the occurrence instant is the identity', () => {
    expect(scheduleTriggerKey('2026-09-02T09:00:00.000Z')).toBe('occ:2026-09-02T09:00:00.000Z');
    expect(scheduleTriggerId('sub-1', '2026-09-02T09:00:00.000Z')).toBe(
      'sch:sub-1:2026-09-02T09:00:00.000Z',
    );
  });

  it('event trigger key/id: the inbox event + subscription pair is the identity', () => {
    expect(eventTriggerKey('evt_abc123')).toBe('evt:evt_abc123');
    expect(eventTriggerId('evt_abc123', 'sub-9')).toBe('evt:evt_abc123:sub-9');
    expect(eventTriggerId('evt_abc123', 'sub-8')).not.toBe(eventTriggerId('evt_abc123', 'sub-9'));
  });

  it('the delivery command id for the run command envelope is (delivery, attempt) — retry-stable', () => {
    expect(deliveryCommandId('dlv-1', 1)).toBe('trgcmd-dlv-1-1');
    expect(deliveryCommandId('dlv-1', 2)).toBe('trgcmd-dlv-1-2');
  });
});

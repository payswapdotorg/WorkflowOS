import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EXECUTION_ATTESTATION_EVENT_NAMES,
  attestationIssuedEvent,
  attestationVerifiedEvent,
  verifyAttestation,
} from '../../../src/execution-attestation/index.js';
import {
  VERIFY_NOW,
  defaultVerifyPolicy,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — typed protocol events (registry canonical event names only):
 * `execution.attestation.issued` and `execution.attestation.verified`.
 * Aliases are forbidden (registry aliasesForbidden).
 */

const REGISTRY_JSON_PATH = fileURLToPath(
  new URL('../../../../spec/architecture/v2/V2-CTRL-003-protocol-registry.json', import.meta.url),
);

describe('V2-014 typed protocol events', () => {
  it('exposes exactly the two canonical registry attestation events', () => {
    expect(EXECUTION_ATTESTATION_EVENT_NAMES).toEqual(['execution.attestation.issued', 'execution.attestation.verified']);
  });

  it('matches the registry file exactly (no drift, aliases impossible)', () => {
    const registry = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8')) as { events: string[] };
    const attestationEvents = registry.events.filter((name) => name.startsWith('execution.attestation.'));
    expect(attestationEvents).toEqual([...EXECUTION_ATTESTATION_EVENT_NAMES]);
  });

  it('rejects non-canonical aliases by construction (the type admits only the canonical names)', () => {
    const valid: string[] = [...EXECUTION_ATTESTATION_EVENT_NAMES];
    const aliases = ['attestation.issued', 'execution.attestation.created', 'execution.attestation.verified.v2', 'execution.attest.issued'];
    for (const alias of aliases) {
      expect(valid, `the alias ${alias} must not be a canonical event name`).not.toContain(alias);
    }
  });

  it('constructs a typed issued event with deterministic identity', () => {
    const attestation = signTriageAttestation();
    const event = attestationIssuedEvent(attestation, VERIFY_NOW);
    expect(event.eventType).toBe('execution.attestation.issued');
    expect(event.eventId).toMatch(/^wfeaev_[0-9a-f]{32}$/);
    expect(event.attestationId).toBe(attestation.attestationId);
    expect(event.executionDigest).toBe(attestation.executionDigest.digest);
    expect(event.attesterKeyId).toBe(attestation.attesterKeyId);
    expect(event.occurredAt).toBe(VERIFY_NOW);
    // deterministic: the same attestation + clock → the same event identity:
    expect(attestationIssuedEvent(attestation, VERIFY_NOW).eventId).toBe(event.eventId);
  });

  it('constructs a typed verified event from a verified fact', () => {
    const attestation = signTriageAttestation();
    const result = verifyAttestation(attestation, defaultVerifyPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const event = attestationVerifiedEvent(result.fact, '2026-09-01T12:00:31.000Z');
      expect(event.eventType).toBe('execution.attestation.verified');
      expect(event.attestationId).toBe(attestation.attestationId);
      expect(event.executionDigest).toBe(attestation.executionDigest.digest);
      expect(event.occurredAt).toBe('2026-09-01T12:00:31.000Z');
      expect(event.eventId).not.toBe(attestationIssuedEvent(attestation, '2026-09-01T12:00:31.000Z').eventId);
    }
  });

  it('keeps event identities distinct across event types for the same attestation (typed, not name-mangled)', () => {
    const attestation = signTriageAttestation();
    const issued = attestationIssuedEvent(attestation, VERIFY_NOW);
    const result = verifyAttestation(attestation, defaultVerifyPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const verified = attestationVerifiedEvent(result.fact, VERIFY_NOW);
      expect(issued.eventId).not.toBe(verified.eventId);
    }
  });

  it('converges duplicate event construction (stable identity, pure data)', () => {
    const attestation = signTriageAttestation();
    const first = attestationIssuedEvent(attestation, VERIFY_NOW);
    const second = attestationIssuedEvent(attestation, '2026-09-01T12:05:00.000Z');
    expect(first.eventId).toBe(second.eventId);
    expect(first.occurredAt).not.toBe(second.occurredAt);
  });
});

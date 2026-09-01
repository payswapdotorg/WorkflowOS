import { describe, it, expect } from 'vitest';
import {
  InMemoryAttestationLedger,
  deriveAttestationIdentity,
  parseAttestation,
  serializeAttestation,
} from '../../../src/execution-attestation/index.js';
import {
  ATTESTER_A,
  ATTESTER_B,
  VERIFY_NOW,
  buildTriageStatement,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — duplicate attestation convergence by stable identity
 * (execution-attestation.md: "Repeated delivery of the same attestation MUST
 * converge by its stable attestation/execution identity").
 */

describe('V2-014 stable attestation identity', () => {
  it('derives the SAME identity for the same statement + attester key', () => {
    const first = signTriageAttestation();
    const second = signTriageAttestation();
    expect(first.attestationId).toBe(second.attestationId);
  });

  it('derives a DIFFERENT identity for a different statement (same attester)', () => {
    const first = signTriageAttestation();
    const second = signTriageAttestation({ statement: buildTriageStatement({ attemptId: 2 }) });
    expect(first.attestationId).not.toBe(second.attestationId);
  });

  it('derives a DIFFERENT identity for the same statement attested by a different key', () => {
    const fromA = signTriageAttestation({ attester: ATTESTER_A });
    const fromB = signTriageAttestation({ attester: ATTESTER_B });
    expect(fromA.attestationId).not.toBe(fromB.attestationId);
    expect(fromA.executionDigest).toEqual(fromB.executionDigest);
  });

  it('derives the identity only from the execution digest + attester key id (explicit derivation)', () => {
    const first = signTriageAttestation();
    const derived = deriveAttestationIdentity(first.executionDigest.digest, first.attesterKeyId);
    expect(derived).toBe(first.attestationId);
    expect(derived).toMatch(/^wfea_[0-9a-f]{32}$/);
    // the attester key id alone does not determine the attestation identity:
    const otherStatement = signTriageAttestation({ statement: buildTriageStatement({ attemptId: 3 }) });
    expect(deriveAttestationIdentity(otherStatement.executionDigest.digest, first.attesterKeyId)).not.toBe(first.attestationId);
  });
});

describe('V2-014 duplicate delivery convergence (ingestion ledger)', () => {
  it('converges repeated deliveries of the SAME attestation bytes', () => {
    const attestation = signTriageAttestation();
    const ledger = new InMemoryAttestationLedger();

    const first = ledger.ingest(attestation, VERIFY_NOW);
    expect(first.kind).toBe('accepted');
    expect(first.attestationId).toBe(attestation.attestationId);
    expect(first.deliveries).toBe(1);

    const second = ledger.ingest(attestation, '2026-09-01T12:00:31.000Z');
    expect(second.kind).toBe('duplicate');
    expect(second.attestationId).toBe(attestation.attestationId);
    expect(second.deliveries).toBe(2);

    const third = ledger.ingest(attestation, '2026-09-01T12:00:32.000Z');
    expect(third.kind).toBe('duplicate');
    expect(third.deliveries).toBe(3);

    expect(first.firstSeenAt).toBe(second.firstSeenAt);
  });

  it('converges a re-serialized + re-parsed copy (byte-identical canonical form, stable identity)', () => {
    const attestation = signTriageAttestation();
    const parsed = parseAttestation(serializeAttestation(attestation));
    expect(parsed.ok).toBe(true);
    const ledger = new InMemoryAttestationLedger();
    expect(ledger.ingest(attestation, VERIFY_NOW).kind).toBe('accepted');
    if (parsed.ok) {
      expect(ledger.ingest(parsed.attestation, VERIFY_NOW).kind).toBe('duplicate');
    }
  });

  it('does NOT converge two different attestations (independent deliveries)', () => {
    const ledger = new InMemoryAttestationLedger();
    const first = signTriageAttestation();
    const second = signTriageAttestation({ statement: buildTriageStatement({ attemptId: 2 }) });
    expect(ledger.ingest(first, VERIFY_NOW).kind).toBe('accepted');
    const outcome = ledger.ingest(second, VERIFY_NOW);
    expect(outcome.kind).toBe('accepted');
    expect(outcome.attestationId).not.toBe(first.attestationId);
  });

  it('records first-seen from the INJECTED clock (deterministic, no wall clock)', () => {
    const attestation = signTriageAttestation();
    const ledger = new InMemoryAttestationLedger();
    const outcome = ledger.ingest(attestation, '2026-09-01T09:00:00.000Z');
    expect(outcome.firstSeenAt).toBe('2026-09-01T09:00:00.000Z');
  });
});

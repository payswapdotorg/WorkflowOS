import { describe, it, expect } from 'vitest';
import {
  parseAttestation,
  serializeAttestation,
  signExecutionAttestation,
  verifyAttestation,
} from '../../../src/execution-attestation/index.js';
import {
  ATTESTER_A,
  ATTESTER_B,
  ATTESTATION_ISSUED_AT,
  buildTriageStatement,
  defaultVerifyPolicy,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — real Ed25519 signature generation/verification and malformed
 * envelope rejection. The verification path uses REAL cryptography (node:crypto
 * Ed25519) — never a mock, never a hash stand-in.
 */

describe('V2-014 signature generation + verification (real Ed25519)', () => {
  it('produces a 128-hex Ed25519 signature that verifies through the real crypto path', () => {
    const attestation = signTriageAttestation();
    expect(attestation.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(attestation.attesterKeyId).toMatch(/^wfeak_[0-9a-f]{32}$/);
    expect(attestation.attestationId).toMatch(/^wfea_[0-9a-f]{32}$/);
    expect(attestation.attesterPublicKey).toMatch(/^[0-9a-f]+$/);

    const result = verifyAttestation(attestation, defaultVerifyPolicy());
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('round-trips: serialize → parse → verify, byte-identical canonical form', () => {
    const attestation = signTriageAttestation();
    const bytes = serializeAttestation(attestation);
    const parsed = parseAttestation(bytes);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (parsed.ok) {
      expect(parsed.attestation).toEqual(attestation);
      expect(serializeAttestation(parsed.attestation)).toBe(bytes);
      expect(verifyAttestation(parsed.attestation, defaultVerifyPolicy()).ok).toBe(true);
    }
  });

  it('signs with the caller-supplied key pair and derives the key id from the public key', () => {
    const attestation = signExecutionAttestation({
      statement: buildTriageStatement(),
      attesterPrivateKey: ATTESTER_B.privateKey,
      attesterPublicKeyDer: ATTESTER_B.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: ATTESTATION_ISSUED_AT,
    });
    expect(attestation.attesterKeyId).toBe(ATTESTER_B.keyId);
    // the policy must pin the right attester or the substitution check fires:
    expect(verifyAttestation(attestation, defaultVerifyPolicy()).ok).toBe(false);
    expect(verifyAttestation(attestation, defaultVerifyPolicy({ attesterKeyIds: [ATTESTER_B.keyId] })).ok).toBe(true);
  });

  it('rejects a mismatched private/public key pair at signing time (typed, fail-closed)', () => {
    expect(() =>
      signExecutionAttestation({
        statement: buildTriageStatement(),
        attesterPrivateKey: ATTESTER_A.privateKey,
        attesterPublicKeyDer: ATTESTER_B.publicKeyDer,
        assurance: 'software_signed',
        issuedAt: ATTESTATION_ISSUED_AT,
      }),
    ).toThrowError(/key/i);
  });
});

describe('V2-014 malformed-envelope rejection (typed, fail-closed)', () => {
  it('rejects non-JSON bytes with ATTESTATION_MALFORMED_ENVELOPE', () => {
    const result = parseAttestation('this is not json at all {{{');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_MALFORMED_ENVELOPE');
    }
  });

  it('rejects structurally broken JSON with ATTESTATION_MALFORMED_ENVELOPE', () => {
    for (const bytes of ['{}', '[]', '"just a string"', 'null', '{"objectType":"workflowos/execution-attestation/v1"}']) {
      const result = parseAttestation(bytes);
      expect(result.ok, bytes).toBe(false);
      if (!result.ok) {
        expect(result.failure.code, bytes).toBe('ATTESTATION_MALFORMED_ENVELOPE');
      }
    }
  });

  it('rejects an envelope missing its signature (unsigned envelope presented)', () => {
    const attestation = signTriageAttestation();
    const unsigned = JSON.parse(serializeAttestation(attestation)) as Record<string, unknown>;
    delete unsigned['signature'];
    const result = parseAttestation(JSON.stringify(unsigned));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_MALFORMED_ENVELOPE');
    }
  });

  it('rejects a tampered canonical byte (string byte flip) with a typed signature failure', () => {
    const bytes = serializeAttestation(signTriageAttestation());
    const tamperedBytes = bytes.replace('notify_channel', 'notify_channfl');
    expect(tamperedBytes).not.toBe(bytes);
    const parsed = parseAttestation(tamperedBytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const result = verifyAttestation(parsed.attestation, defaultVerifyPolicy());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe('ATTESTATION_SIGNATURE_INVALID');
      }
    }
  });

  it('rejects a tampered structural byte (broken JSON) as malformed', () => {
    const bytes = serializeAttestation(signTriageAttestation());
    const index = bytes.indexOf('{');
    const tamperedBytes = `${bytes.slice(0, index)}[${bytes.slice(index)}`;
    const result = parseAttestation(tamperedBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_MALFORMED_ENVELOPE');
    }
  });

  it('rejects an envelope whose signature is not 128-hex as malformed', () => {
    const attestation = signTriageAttestation();
    const broken = { ...attestation, signature: 'deadbeef' } as never;
    const result = parseAttestation(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_MALFORMED_ENVELOPE');
    }
  });
});

import { describe, it, expect } from 'vitest';
import { verifyAttestation } from '../../../src/execution-attestation/index.js';
import {
  ATTESTER_A,
  buildTriageStatement,
  defaultVerifyPolicy,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — identity separation (invariant 4): attestation identity, Node
 * identity, workload identity, and attester key identity are DISTINCT
 * identities with distinct derivations and formats. They are never collapsed
 * and never substitutable for one another.
 */

describe('V2-014 attestation identity vs Node identity vs workload identity', () => {
  it('uses distinct identity namespaces/formats for all four identities', () => {
    const attestation = signTriageAttestation();
    expect(attestation.attestationId).toMatch(/^wfea_[0-9a-f]{32}$/);
    expect(attestation.attesterKeyId).toMatch(/^wfeak_[0-9a-f]{32}$/);
    // Node identity is V2-004's opaque node id (node_<hex>), never re-derived here:
    expect(attestation.statement.nodeId).toMatch(/^node_[0-9a-f]{16}$/);
    expect(attestation.statement.workloadIdentity).toMatch(/^wl_/);
    // all four values are pairwise distinct strings:
    const identities = [
      attestation.attestationId,
      attestation.attesterKeyId,
      attestation.statement.nodeId,
      attestation.statement.workloadIdentity ?? '',
    ];
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('attestation identity is NOT node identity: the same node across two executions yields different attestation identities', () => {
    const first = signTriageAttestation({ statement: buildTriageStatement({ attemptId: 1 }) });
    const second = signTriageAttestation({ statement: buildTriageStatement({ attemptId: 2 }) });
    expect(first.statement.nodeId).toBe(second.statement.nodeId);
    expect(first.attestationId).not.toBe(second.attestationId);
  });

  it('attestation identity is NOT workload identity: same workload, different action → different attestation identity', () => {
    const first = signTriageAttestation();
    const second = signTriageAttestation({ statement: buildTriageStatement({ action: 'Log the rejected triage summary' }) });
    expect(first.statement.workloadIdentity).toBe(second.statement.workloadIdentity);
    expect(first.attestationId).not.toBe(second.attestationId);
  });

  it('attestation identity is NOT the attester key identity: the same statement attested by two keys differs only in the attester dimension', () => {
    const fromA = signTriageAttestation({ attester: ATTESTER_A });
    const fromB = signTriageAttestation({ attester: ATTESTER_B });
    expect(fromA.executionDigest).toEqual(fromB.executionDigest);
    expect(fromA.attesterKeyId).not.toBe(fromB.attesterKeyId);
    expect(fromA.attestationId).not.toBe(fromB.attestationId);
    // and a single key attesting two different statements differs only in the
    // statement dimension:
    const other = signTriageAttestation({ statement: buildTriageStatement({ attemptId: 4 }) });
    expect(other.attesterKeyId).toBe(fromA.attesterKeyId);
    expect(other.attestationId).not.toBe(fromA.attestationId);
  });

  it('the attester key id is a stable derivation of the public key alone (key identity ≠ attestation identity)', () => {
    const a = signTriageAttestation();
    const b = signTriageAttestation();
    expect(a.attesterKeyId).toBe(b.attesterKeyId);
    expect(a.attestationId).toBe(b.attestationId);
    // different keys never collide on key ids (real generated key pairs):
    expect(ATTESTER_A.keyId).not.toBe(ATTESTER_B.keyId);
    expect(ATTESTER_A.publicKeyDer).not.toBe(ATTESTER_B.publicKeyDer);
  });

  it('the verified fact reports all identity dimensions as SEPARATE fields (no collapsed identity)', () => {
    const attestation = signTriageAttestation();
    const result = verifyAttestation(attestation, defaultVerifyPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fact = result.fact;
      expect(fact.attestationId).toBe(attestation.attestationId);
      expect(fact.attesterKeyId).toBe(attestation.attesterKeyId);
      expect(fact.statement.nodeId).toBe(attestation.statement.nodeId);
      expect(fact.statement.workloadIdentity).toBe(attestation.statement.workloadIdentity);
    }
  });
});

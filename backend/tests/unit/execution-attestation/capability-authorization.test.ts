import { describe, it, expect } from 'vitest';
import * as attestationBarrel from '../../../src/execution-attestation/index.js';
import { verifyAttestation } from '../../../src/execution-attestation/index.js';
import { EXECUTION_ATTESTATION_REGISTRY_VOCABULARY } from '../../../src/execution-attestation/index.js';
import {
  buildTriageStatement,
  defaultVerifyPolicy,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — capability-vs-authorization discrimination (invariant 5, registry
 * authorityRules `capability-advertisement-is-not-authorization` and
 * `signature-is-not-automatic-execution-truth`): a VALID signature never
 * implies authorization, correct behavior, or sufficient evidence. The
 * verification result is structurally incapable of granting authority.
 */

describe('V2-014 capability is not authorization (structural discrimination)', () => {
  it('exposes NO authorization-granting API on the public module surface', () => {
    const exports = Object.keys(attestationBarrel).sort();
    const authorityish = exports.filter((name) => /authoriz|permi[sst]|grant|approve|allow/i.test(name));
    expect(authorityish, `no authorization surface may exist: ${JSON.stringify(authorityish)}`).toEqual([]);
  });

  it('embeds the registry authority rules that keep attestation non-authoritative', () => {
    expect(EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.authorityRules).toContain('signature-is-not-automatic-execution-truth');
    expect(EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.authorityRules).toContain('attestation-is-not-verification-authority');
    expect(EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.authorityRules).toContain('capability-advertisement-is-not-authorization');
  });
});

describe('V2-014 the verified fact never asserts authorization (invariant 5)', () => {
  it('returns a fact whose key set contains ONLY authenticity-domain fields', () => {
    const attestation = signTriageAttestation();
    const result = verifyAttestation(attestation, defaultVerifyPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.fact).sort()).toEqual([
        'assurance',
        'attestationId',
        'attesterKeyId',
        'attests',
        'executionDigest',
        'neverAsserts',
        'nonAuthorityNote',
        'statement',
        'verifiedAt',
      ]);
    }
  });

  it('marks the non-authority dimensions explicitly on every verified fact', () => {
    const attestation = signTriageAttestation();
    const result = verifyAttestation(attestation, defaultVerifyPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fact.attests).toBe('statement_authenticity');
      expect(result.fact.neverAsserts).toContain('authorization');
      expect(result.fact.neverAsserts).toContain('capability_possession');
      expect(result.fact.neverAsserts).toContain('correct_behavior');
      expect(result.fact.neverAsserts).toContain('observed_effect');
      expect(result.fact.neverAsserts).toContain('sufficient_evidence');
      expect(result.fact.nonAuthorityNote).toContain('authorization');
    }
  });

  it('verifies a capability-bearing statement WITHOUT any capability-possession or authorization outcome', () => {
    // the statement invokes messaging.send — verification says NOTHING about
    // whether the node possesses that capability or was authorized to use it:
    const attestation = signTriageAttestation({ statement: buildTriageStatement({ capability: 'messaging.send' }) });
    const result = verifyAttestation(attestation, defaultVerifyPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fact.statement.capability).toBe('messaging.send');
      expect(result.fact.neverAsserts).toContain('authorization');
      expect(result.fact.neverAsserts).toContain('capability_possession');
    }
  });

  it('treats a statement WITHOUT any capability identically (the outcome is authenticity, not capability eligibility)', () => {
    const withCapability = signTriageAttestation({ statement: buildTriageStatement({ capability: 'messaging.send' }) });
    const withoutCapability = signTriageAttestation({ statement: buildTriageStatement({ capability: undefined }) });
    const a = verifyAttestation(withCapability, defaultVerifyPolicy());
    const b = verifyAttestation(withoutCapability, defaultVerifyPolicy());
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.fact.attests).toBe(b.fact.attests);
      expect(a.fact.neverAsserts).toEqual(b.fact.neverAsserts);
    }
  });
});

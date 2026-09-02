import { describe, it, expect } from 'vitest';
import { serializeWorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import {
  canonicalStatementJson,
  parseAttestation,
  serializeAttestation,
  validateExecutionStatement,
  verifyAttestation,
} from '../../../src/execution-attestation/index.js';
import { buildTriageDocument } from '../workflow-ir/helpers.js';
import {
  ATTESTER_A,
  ATTESTER_B,
  buildTriageStatement,
  defaultVerifyPolicy,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — substitution rejection (invariant 7): cross-attester/key
 * substitution and cross-protocol/cross-object substitution are rejected by
 * TYPED, domain-separated verification.
 */

describe('V2-014 cross-attester substitution rejection', () => {
  it('rejects an attestation signed by a DIFFERENT attester key when the policy pins the expected attester (valid signature, unexpected attester)', () => {
    const fromB = signTriageAttestation({ attester: ATTESTER_B });
    // B's signature is REAL and VALID under B's embedded public key:
    const underB = verifyAttestation(fromB, defaultVerifyPolicy({ attesterKeyIds: [ATTESTER_B.keyId] }));
    expect(underB.ok, 'B is cryptographically authentic').toBe(true);

    // but the policy expecting A rejects the substitution, typed:
    const result = verifyAttestation(fromB, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ATTESTER_UNEXPECTED');
      expect(result.failure.detail).toContain(ATTESTER_A.keyId);
      expect(result.failure.detail).toContain(ATTESTER_B.keyId);
    }
  });

  it('rejects every attester when the policy trusts nobody (empty attester allow-list, fail-closed)', () => {
    const attestation = signTriageAttestation();
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ attesterKeyIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ATTESTER_UNEXPECTED');
    }
  });

  it('rejects an envelope whose attesterKeyId does not match its embedded public key (identity/key inconsistency)', () => {
    const attestation = signTriageAttestation({ attester: ATTESTER_A });
    // swap in B's key id while keeping A's key + A's valid signature:
    const forged = { ...attestation, attesterKeyId: ATTESTER_B.keyId };
    const result = verifyAttestation(forged, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ATTESTER_KEY_ID_MISMATCH');
    }
  });
});

describe('V2-014 cross-protocol substitution rejection (typed domain separation)', () => {
  it('rejects a serialized WorkflowIR document presented as an attestation envelope (V2-003 object in the V2-014 channel)', () => {
    const irBytes = serializeWorkflowIrDocument(buildTriageDocument());
    const result = parseAttestation(irBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_DOMAIN_MISMATCH');
      expect(result.failure.detail).toContain('workflowos/workflow-ir/v1');
    }
  });

  it('rejects a canonical ExecutionStatement presented as an attestation envelope (statement ≠ envelope)', () => {
    const statementBytes = canonicalStatementJson(buildTriageStatement());
    const result = parseAttestation(statementBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_DOMAIN_MISMATCH');
    }
  });

  it('rejects a V2-002-style opaque content document presented as an attestation envelope', () => {
    const repositoryPayload = JSON.stringify({
      objectType: 'workflow-version-content/v1',
      title: 'On-call triage',
      steps: [],
    });
    const result = parseAttestation(repositoryPayload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_DOMAIN_MISMATCH');
    }
  });

  it('rejects an attestation envelope presented as an ExecutionStatement (envelope ≠ statement)', () => {
    const attestation = signTriageAttestation();
    const result = validateExecutionStatement(attestation as never);
    expect(result.ok).toBe(false);
  });

  it('rejects an envelope whose INNER statement carries a foreign object type (cross-object substitution inside the envelope)', () => {
    const attestation = signTriageAttestation();
    const forged = {
      ...attestation,
      statement: { ...attestation.statement, objectType: 'workflowos/workflow-ir/v1' },
    };
    // serialized through the raw JSON path (serializeAttestation validates and
    // would reject it), so the parse path must catch the foreign inner type:
    const result = parseAttestation(JSON.stringify(forged));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_DOMAIN_MISMATCH');
    }
  });

  it('rejects an attestation whose envelope object type was mutated, even before signature evaluation (parse-level domain check)', () => {
    const attestation = signTriageAttestation();
    const mutated = JSON.parse(serializeAttestation(attestation)) as Record<string, unknown>;
    mutated['objectType'] = 'workflowos/execution-statement/v1';
    const result = parseAttestation(JSON.stringify(mutated));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_DOMAIN_MISMATCH');
    }
  });
});

describe('V2-014 no cross-RUN substitution (statement channel integrity)', () => {
  it('rejects a statement from one run verified under another run\'s full freshness context (nonce scoped to the attempt)', () => {
    const fromOtherRun = signTriageAttestation({ statement: buildTriageStatement({ runId: 'wfr-triage-20260901-7777', nonce: 'challenge-run-7777-attempt-1' }) });
    const result = verifyAttestation(fromOtherRun, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // the run binding is checked before the nonce; both are typed rejections
      expect(['ATTESTATION_BINDING_MISMATCH', 'ATTESTATION_NONCE_UNEXPECTED']).toContain(result.failure.code);
    }
  });
});

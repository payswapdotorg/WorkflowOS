import { describe, it, expect } from 'vitest';
import { sign as ed25519Sign } from 'node:crypto';
import { computeWorkflowVersionSemanticDigest } from '../../../src/workflow-ir/index.js';
import { signingPreimageJson } from '../../../src/execution-attestation/internal/envelope.js';
import {
  ASSURANCE_LEVELS,
  assuranceRank,
  canonicalStatementJson,
  signExecutionAttestation,
  verifyAttestation,
} from '../../../src/execution-attestation/index.js';
import type { ExecutionAttestation } from '../../../src/execution-attestation/index.js';
import { buildTriageDocument } from '../workflow-ir/helpers.js';
import {
  ATTESTATION_ISSUED_AT,
  ATTESTER_A,
  buildTriageStatement,
  defaultVerifyPolicy,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — the assurance vocabulary (invariants 9 + 10): explicit levels,
 * representable evidence, no silent downgrade, and NO WorkflowIR semantic
 * change under any assurance level.
 */

/** Re-sign a hand-crafted envelope with the REAL Ed25519 private key. */
function resignWithKeyA(envelope: ExecutionAttestation): ExecutionAttestation {
  const preimage = signingPreimageJson(envelope);
  const signature = ed25519Sign(null, Buffer.from(preimage, 'utf8'), ATTESTER_A.privateKey).toString('hex');
  return { ...envelope, signature };
}

describe('V2-014 assurance vocabulary', () => {
  it('exposes exactly the registry assurance identifiers in the canonical order', () => {
    expect(ASSURANCE_LEVELS).toEqual(['software_signed', 'hardware_backed', 'tee_attested', 'verifiable_computation']);
  });

  it('ranks the levels monotonically (software < hardware < tee < verifiable computation)', () => {
    expect(assuranceRank('software_signed')).toBeLessThan(assuranceRank('hardware_backed'));
    expect(assuranceRank('hardware_backed')).toBeLessThan(assuranceRank('tee_attested'));
    expect(assuranceRank('tee_attested')).toBeLessThan(assuranceRank('verifiable_computation'));
  });

  it('accepts a stronger assurance than the policy requires (optional stronger assurance)', () => {
    const attestation = signTriageAttestation({
      assurance: 'hardware_backed',
      assuranceEvidence: [{ kind: 'opaque_reference', reference: 'hsm://slot-7/key-triage-attester' }],
    });
    expect(attestation.assurance).toBe('hardware_backed');
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ requiredAssurance: 'software_signed' }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});

describe('V2-014 stronger assurance requires representable evidence (no silent claims)', () => {
  it('rejects signing with hardware_backed/tee_attested/verifiable_computation WITHOUT assurance evidence', () => {
    for (const level of ['hardware_backed', 'tee_attested', 'verifiable_computation'] as const) {
      expect(() => signTriageAttestation({ assurance: level }), `${level} without evidence must be rejected at build time`).toThrowError(/evidence/i);
    }
  });

  it('accepts stronger assurance WITH representable evidence', () => {
    const attestation = signExecutionAttestation({
      statement: buildTriageStatement(),
      attesterPrivateKey: ATTESTER_A.privateKey,
      attesterPublicKeyDer: ATTESTER_A.publicKeyDer,
      assurance: 'hardware_backed',
      assuranceEvidence: [{ kind: 'opaque_reference', reference: 'hsm://slot-7/key-triage-attester' }],
      issuedAt: ATTESTATION_ISSUED_AT,
    });
    expect(attestation.assuranceEvidence).toEqual([{ kind: 'opaque_reference', reference: 'hsm://slot-7/key-triage-attester' }]);
    expect(verifyAttestation(attestation, defaultVerifyPolicy({ requiredAssurance: 'hardware_backed' })).ok).toBe(true);
  });

  it('rejects a forged envelope claiming tee_attested with NO evidence (typed ASSURANCE_EVIDENCE_MISSING)', () => {
    // build a valid software_signed attestation, then hand-craft the same
    // envelope claiming tee_attested WITHOUT evidence and re-sign it with the
    // REAL private key (real crypto) — the assurance-evidence check is what
    // must reject it:
    const base = signTriageAttestation();
    const forged = resignWithKeyA({ ...base, assurance: 'tee_attested', assuranceEvidence: undefined });

    const result = verifyAttestation(forged, defaultVerifyPolicy());
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ASSURANCE_EVIDENCE_MISSING');
    }
  });
});

describe('V2-014 assurance downgrade rejection (invariant 10 — never silent)', () => {
  it('rejects software_signed attestation under a hardware_backed policy with the typed failure', () => {
    const attestation = signTriageAttestation({ assurance: 'software_signed' });
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ requiredAssurance: 'hardware_backed' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ASSURANCE_INSUFFICIENT');
      expect(result.failure.detail).toContain('hardware_backed');
      expect(result.failure.detail).toContain('software_signed');
    }
  });

  it('NEVER downgrades silently: the failure is the honest report, never a weakened success', () => {
    const attestation = signTriageAttestation({ assurance: 'software_signed' });
    const policy = defaultVerifyPolicy({ requiredAssurance: 'verifiable_computation' });
    const result = verifyAttestation(attestation, policy);
    // the ONLY acceptable outcome for a decision that requires
    // verifiable_computation is a typed rejection — never a success with a
    // silently weakened assurance claim:
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ASSURANCE_INSUFFICIENT');
    }
  });
});

describe('V2-014 assurance never changes WorkflowIR semantics (invariant 9)', () => {
  it('does not appear in the statement canonical form (assurance is an envelope property)', () => {
    expect(canonicalStatementJson(buildTriageStatement())).not.toContain('assurance');
  });

  it('leaves the ExecutionDigest and the WorkflowVersion semantic digest unchanged across assurance levels', () => {
    const triage = buildTriageDocument();
    const semanticDigestBefore = computeWorkflowVersionSemanticDigest(triage).digest;

    const software = signTriageAttestation({ assurance: 'software_signed' });
    const tee = signExecutionAttestation({
      statement: buildTriageStatement(),
      attesterPrivateKey: ATTESTER_A.privateKey,
      attesterPublicKeyDer: ATTESTER_A.publicKeyDer,
      assurance: 'tee_attested',
      assuranceEvidence: [{ kind: 'opaque_reference', reference: 'tee://measurement/abc' }],
      issuedAt: ATTESTATION_ISSUED_AT,
    });

    // same statement → same execution digest, different envelope + signature:
    expect(tee.executionDigest).toEqual(software.executionDigest);
    expect(tee.signature).not.toBe(software.signature);
    expect(tee.assurance).not.toBe(software.assurance);

    // the workflow's OWN semantic identity is untouched by attestation assurance:
    expect(computeWorkflowVersionSemanticDigest(triage).digest).toBe(semanticDigestBefore);
  });
});

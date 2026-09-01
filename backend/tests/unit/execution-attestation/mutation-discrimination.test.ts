import { describe, it, expect } from 'vitest';
import { sign as ed25519Sign } from 'node:crypto';
import { signingPreimageJson } from '../../../src/execution-attestation/internal/envelope.js';
import { digestOfStatementObject } from '../../../src/execution-attestation/internal/statement.js';
import {
  InMemoryReplayRegistry,
  runVerificationPipeline,
  verifyAttestation,
  computeExecutionDigest,
  VERIFICATION_CHECKS,
} from '../../../src/execution-attestation/internal/verify.js';
import type { AttestationVerification, ExecutionAttestation } from '../../../src/execution-attestation/index.js';
import {
  ATTESTER_A,
  ATTESTER_B,
  LATE_NOW,
  STATEMENT_EPOCH,
  VERIFY_NOW,
  buildTriageStatement,
  defaultVerifyPolicy,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — mutation/discrimination evidence (work order "Required
 * verification": removal of each critical check causes the corresponding
 * invariant test's assertion to FAIL).
 *
 * Every mutation below REMOVES one critical verification check and
 * demonstrates that the corresponding invariant assertion would fail under the
 * mutation. Mutations are TEST-LOCAL: the production `verifyAttestation` is
 * pinned to the FULL ordered check pipeline (asserted below); the mutated
 * variants are constructed by running the same REAL production checks minus
 * exactly one, through `runVerificationPipeline` — no source file is modified
 * and no check-skipping option exists in the public API.
 *
 * Where a mutation needs an adversarial envelope with a VALID signature, the
 * test re-signs it with the REAL Ed25519 private key through node:crypto —
 * real cryptography, never a mock.
 */

/** The pipeline with exactly one check REMOVED (the mutation). */
function withoutCheck(checkId: string): typeof VERIFICATION_CHECKS {
  return VERIFICATION_CHECKS.filter((check) => check.id !== checkId);
}

/** Re-sign a hand-crafted envelope with the REAL private key (valid signature). */
function resign(envelope: ExecutionAttestation, key: typeof ATTESTER_A = ATTESTER_A): ExecutionAttestation {
  const preimage = signingPreimageJson(envelope);
  const signature = ed25519Sign(null, Buffer.from(preimage, 'utf8'), key.privateKey).toString('hex');
  return { ...envelope, signature };
}

function mutatedVerifies(attestation: ExecutionAttestation, policy: Parameters<typeof verifyAttestation>[1], checkId: string): boolean {
  const result: AttestationVerification = runVerificationPipeline(attestation, policy, withoutCheck(checkId));
  return result.ok;
}

describe('V2-014 mutation evidence 0 — the production pipeline is the full check list', () => {
  it('runs exactly the ordered critical checks (no skip surface in the public API)', () => {
    expect(VERIFICATION_CHECKS.map((check) => check.id)).toEqual([
      'envelope-shape',
      'envelope-domain',
      'statement-domain',
      'attester-key-id',
      'signature',
      'expected-attester',
      'digest-match',
      'bindings',
      'freshness-nonce',
      'freshness-epoch',
      'freshness-expiry',
      'freshness-replay',
      'assurance-evidence',
      'assurance-sufficiency',
    ]);
    expect(typeof runVerificationPipeline).toBe('function');
  });
});

describe('V2-014 mutation evidence 1 — remove the envelope-domain check (cross-protocol substitution)', () => {
  it('MUTATED: a foreign-objectType envelope with a VALID signature VERIFIES — the cross-protocol test FAILS', () => {
    const valid = signTriageAttestation();
    const foreign = resign({ ...valid, objectType: 'workflowos/workflow-ir/v1' });
    expect(mutatedVerifies(foreign, defaultVerifyPolicy(), 'envelope-domain')).toBe(true);
  });

  it('RESTORED: the same envelope is rejected with the typed domain-mismatch failure', () => {
    const valid = signTriageAttestation();
    const foreign = resign({ ...valid, objectType: 'workflowos/workflow-ir/v1' });
    const result = verifyAttestation(foreign, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_DOMAIN_MISMATCH');
    }
  });
});

describe('V2-014 mutation evidence 2 — remove the statement-domain check (cross-object substitution)', () => {
  it('MUTATED: an envelope carrying a foreign-typed inner statement VERIFIES — the substitution test FAILS', () => {
    const valid = signTriageAttestation();
    const foreignStatement = { ...valid.statement, objectType: 'workflowos/execution-attestation/v1' } as typeof valid.statement;
    const foreign = resign({
      ...valid,
      statement: foreignStatement,
      executionDigest: { ...valid.executionDigest, digest: digestOfStatementObject(foreignStatement) },
    });
    expect(mutatedVerifies(foreign, defaultVerifyPolicy(), 'statement-domain')).toBe(true);
  });

  it('RESTORED: the same envelope is rejected with the typed domain-mismatch failure', () => {
    const valid = signTriageAttestation();
    const foreignStatement = { ...valid.statement, objectType: 'workflowos/execution-attestation/v1' } as typeof valid.statement;
    const foreign = resign({
      ...valid,
      statement: foreignStatement,
      executionDigest: { ...valid.executionDigest, digest: digestOfStatementObject(foreignStatement) },
    });
    const result = verifyAttestation(foreign, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_DOMAIN_MISMATCH');
    }
  });
});

describe('V2-014 mutation evidence 3 — remove the digest-match check (envelope/statement consistency)', () => {
  it('MUTATED: a VALIDLY-SIGNED envelope whose digest does not match its statement VERIFIES — the digest-integrity test FAILS', () => {
    const valid = signTriageAttestation();
    const mismatched = resign({
      ...valid,
      executionDigest: { ...valid.executionDigest, digest: computeExecutionDigest(buildTriageStatement({ attemptId: 9 })).digest },
    });
    expect(mutatedVerifies(mismatched, defaultVerifyPolicy(), 'digest-match')).toBe(true);
  });

  it('RESTORED: the same envelope is rejected with the typed digest-mismatch failure', () => {
    const valid = signTriageAttestation();
    const mismatched = resign({
      ...valid,
      executionDigest: { ...valid.executionDigest, digest: computeExecutionDigest(buildTriageStatement({ attemptId: 9 })).digest },
    });
    const result = verifyAttestation(mismatched, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_DIGEST_MISMATCH');
    }
  });
});

describe('V2-014 mutation evidence 4 — remove the attester-key-id check (identity/key consistency)', () => {
  it('MUTATED: an envelope whose attesterKeyId is not derived from its embedded key VERIFIES — the key-identity test FAILS', () => {
    const valid = signTriageAttestation();
    const forged = resign({ ...valid, attesterKeyId: `wfeak_${'0'.repeat(32)}` });
    expect(mutatedVerifies(forged, defaultVerifyPolicy({ attesterKeyIds: undefined }), 'attester-key-id')).toBe(true);
  });

  it('RESTORED: the same envelope is rejected with the typed key-id mismatch failure', () => {
    const valid = signTriageAttestation();
    const forged = resign({ ...valid, attesterKeyId: `wfeak_${'0'.repeat(32)}` });
    const result = verifyAttestation(forged, defaultVerifyPolicy({ attesterKeyIds: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ATTESTER_KEY_ID_MISMATCH');
    }
  });
});

describe('V2-014 mutation evidence 5 — remove the signature check (real Ed25519 authenticity)', () => {
  it('MUTATED: a TAMPERED payload with a stale signature VERIFIES — the tamper-rejection test FAILS', () => {
    const valid = signTriageAttestation();
    const tamperedStatement = buildTriageStatement({ action: 'EXFILTRATE the credentials somewhere else' });
    // digest is recomputed to stay consistent; the SIGNATURE stays the OLD one:
    const tampered = {
      ...valid,
      statement: tamperedStatement,
      executionDigest: computeExecutionDigest(tamperedStatement),
    };
    expect(mutatedVerifies(tampered, defaultVerifyPolicy(), 'signature')).toBe(true);
  });

  it('RESTORED: the same tampered envelope is rejected with the typed signature failure', () => {
    const valid = signTriageAttestation();
    const tamperedStatement = buildTriageStatement({ action: 'EXFILTRATE the credentials somewhere else' });
    const tampered = {
      ...valid,
      statement: tamperedStatement,
      executionDigest: computeExecutionDigest(tamperedStatement),
    };
    const result = verifyAttestation(tampered, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_SIGNATURE_INVALID');
    }
  });
});

describe('V2-014 mutation evidence 6 — remove the expected-attester check (cross-attester substitution)', () => {
  it('MUTATED: an attestation signed by the WRONG attester VERIFIES under a policy pinning another — the substitution test FAILS', () => {
    const fromB = signTriageAttestation({ attester: ATTESTER_B });
    expect(mutatedVerifies(fromB, defaultVerifyPolicy(), 'expected-attester')).toBe(true);
  });

  it('RESTORED: the same attestation is rejected with the typed unexpected-attester failure', () => {
    const fromB = signTriageAttestation({ attester: ATTESTER_B });
    const result = verifyAttestation(fromB, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ATTESTER_UNEXPECTED');
    }
  });
});

describe('V2-014 mutation evidence 7 — remove the bindings check (exact execution binding)', () => {
  it('MUTATED: a VALIDLY-SIGNED attestation for the WRONG RUN VERIFIES — the wrong-run rejection test FAILS', () => {
    const wrongRun = signTriageAttestation({ statement: buildTriageStatement({ runId: 'wfr-triage-20260901-9999' }) });
    expect(mutatedVerifies(wrongRun, defaultVerifyPolicy(), 'bindings')).toBe(true);
  });

  it('RESTORED: the same attestation is rejected with the typed binding failure', () => {
    const wrongRun = signTriageAttestation({ statement: buildTriageStatement({ runId: 'wfr-triage-20260901-9999' }) });
    const result = verifyAttestation(wrongRun, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(result.failure.dimension).toBe('run');
    }
  });
});

describe('V2-014 mutation evidence 8 — remove the freshness-nonce check (challenge binding)', () => {
  it('MUTATED: an attestation carrying an UNEXPECTED NONCE VERIFIES — the nonce test FAILS', () => {
    const attestation = signTriageAttestation();
    const policy = defaultVerifyPolicy({ expectedNonce: 'challenge-for-a-different-attempt' });
    expect(mutatedVerifies(attestation, policy, 'freshness-nonce')).toBe(true);
  });

  it('RESTORED: the same attestation is rejected with the typed nonce failure', () => {
    const attestation = signTriageAttestation();
    const policy = defaultVerifyPolicy({ expectedNonce: 'challenge-for-a-different-attempt' });
    const result = verifyAttestation(attestation, policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_NONCE_UNEXPECTED');
    }
  });
});

describe('V2-014 mutation evidence 9 — remove the freshness-epoch check (epoch staleness)', () => {
  it('MUTATED: a STALE-EPOCH attestation VERIFIES — the staleness test FAILS', () => {
    const stale = signTriageAttestation({ statement: buildTriageStatement({ epoch: STATEMENT_EPOCH - 1 }) });
    expect(mutatedVerifies(stale, defaultVerifyPolicy({ currentEpoch: STATEMENT_EPOCH }), 'freshness-epoch')).toBe(true);
  });

  it('RESTORED: the same attestation is rejected with the typed epoch-staleness failure', () => {
    const stale = signTriageAttestation({ statement: buildTriageStatement({ epoch: STATEMENT_EPOCH - 1 }) });
    const result = verifyAttestation(stale, defaultVerifyPolicy({ currentEpoch: STATEMENT_EPOCH }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_EPOCH_STALE');
    }
  });
});

describe('V2-014 mutation evidence 10 — remove the freshness-expiry check (bounded validity)', () => {
  it('MUTATED: an EXPIRED attestation VERIFIES — the expiry test FAILS', () => {
    const attestation = signTriageAttestation();
    expect(mutatedVerifies(attestation, defaultVerifyPolicy({ now: LATE_NOW }), 'freshness-expiry')).toBe(true);
  });

  it('RESTORED: the same attestation is rejected with the typed expiry failure', () => {
    const attestation = signTriageAttestation();
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ now: LATE_NOW }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_EXPIRED');
    }
  });
});

describe('V2-014 mutation evidence 11 — remove the freshness-replay check (single-use nonce)', () => {
  it('MUTATED: a REPLAYED attestation (nonce already consumed) VERIFIES — the anti-replay test FAILS', () => {
    const attestation = signTriageAttestation();
    const registry = new InMemoryReplayRegistry();
    registry.consume({ runId: 'wfr-triage-20260901-0001', attemptId: 1, nonce: 'challenge-triage-run-0001-attempt-1' });
    expect(mutatedVerifies(attestation, defaultVerifyPolicy({ replayRegistry: registry }), 'freshness-replay')).toBe(true);
  });

  it('RESTORED: the same attestation is rejected with the typed replay failure', () => {
    const attestation = signTriageAttestation();
    const registry = new InMemoryReplayRegistry();
    registry.consume({ runId: 'wfr-triage-20260901-0001', attemptId: 1, nonce: 'challenge-triage-run-0001-attempt-1' });
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ replayRegistry: registry }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_REPLAYED');
    }
  });
});

describe('V2-014 mutation evidence 12 — remove the assurance-sufficiency check (downgrade protection)', () => {
  it('MUTATED: a software_signed attestation passes a hardware_backed policy — a SILENT DOWNGRADE (the downgrade test FAILS)', () => {
    const attestation = signTriageAttestation({ assurance: 'software_signed' });
    const policy = defaultVerifyPolicy({ requiredAssurance: 'hardware_backed' });
    expect(mutatedVerifies(attestation, policy, 'assurance-sufficiency')).toBe(true);
  });

  it('RESTORED: the same attestation is rejected with the typed assurance-insufficient failure (honest, never silent)', () => {
    const attestation = signTriageAttestation({ assurance: 'software_signed' });
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ requiredAssurance: 'hardware_backed' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ASSURANCE_INSUFFICIENT');
    }
  });
});

describe('V2-014 mutation evidence 13 — remove the assurance-evidence check (evidence representability)', () => {
  it('MUTATED: a forged tee_attested envelope WITHOUT evidence VERIFIES — the evidence test FAILS', () => {
    const valid = signTriageAttestation();
    const forged = resign({ ...valid, assurance: 'tee_attested', assuranceEvidence: undefined });
    expect(mutatedVerifies(forged, defaultVerifyPolicy(), 'assurance-evidence')).toBe(true);
  });

  it('RESTORED: the same envelope is rejected with the typed missing-evidence failure', () => {
    const valid = signTriageAttestation();
    const forged = resign({ ...valid, assurance: 'tee_attested', assuranceEvidence: undefined });
    const result = verifyAttestation(forged, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ASSURANCE_EVIDENCE_MISSING');
    }
  });
});

describe('V2-014 mutation evidence 14 — remove the envelope-shape check (structural fail-closed)', () => {
  it('MUTATED: a type-corrupted envelope (attemptId as string) VERIFIES — the malformed-envelope test FAILS', () => {
    const valid = signTriageAttestation();
    const corruptedStatement = { ...valid.statement, attemptId: '1' } as unknown as typeof valid.statement;
    const corrupted = resign({
      ...valid,
      statement: corruptedStatement,
      executionDigest: { ...valid.executionDigest, digest: digestOfStatementObject(corruptedStatement) },
    });
    const policy = defaultVerifyPolicy({ bindings: { attemptId: undefined } });
    expect(mutatedVerifies(corrupted, policy, 'envelope-shape')).toBe(true);
  });

  it('RESTORED: the same envelope is rejected with the typed malformed-envelope failure', () => {
    const valid = signTriageAttestation();
    const corruptedStatement = { ...valid.statement, attemptId: '1' } as unknown as typeof valid.statement;
    const corrupted = resign({
      ...valid,
      statement: corruptedStatement,
      executionDigest: { ...valid.executionDigest, digest: digestOfStatementObject(corruptedStatement) },
    });
    const policy = defaultVerifyPolicy({ bindings: { attemptId: undefined } });
    const result = verifyAttestation(corrupted, policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_MALFORMED_ENVELOPE');
    }
  });
});

describe('V2-014 mutation evidence — the replay-registry consumption survives only full success', () => {
  it('consumes the nonce on a full-pipeline success (verified at RESTORED behavior)', () => {
    const attestation = signTriageAttestation();
    const registry = new InMemoryReplayRegistry();
    const policy = defaultVerifyPolicy({ replayRegistry: registry, now: VERIFY_NOW });
    expect(verifyAttestation(attestation, policy).ok).toBe(true);
    const replay = verifyAttestation(attestation, policy);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.failure.code).toBe('ATTESTATION_REPLAYED');
    }
  });
});

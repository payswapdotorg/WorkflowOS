/**
 * V2-005 — the Run-boundary attestation verification policy construction
 * (PURE): the boundary CONSUMES the merged V2-014 verifier (never redefines
 * attestation semantics) and feeds it run-derived binding expectations +
 * an injected freshness context. Proven here with REAL V2-014 Ed25519
 * attestations — no DB, no mocks of the crypto path.
 *
 * The "claims hardware_backed WITHOUT representable evidence" case models a
 * FOREIGN producer: the merged V2-014 signer itself refuses to sign such an
 * envelope (fail-closed at the source), so the fixture builds a REAL
 * correctly-signed envelope through the exported canonical-JSON discipline +
 * node:crypto directly — exactly what a non-WorkflowOS producer of the same
 * protocol would emit. The verifier (the only verification authority) must
 * fail closed on it.
 */
import { describe, it, expect } from 'vitest';
import { sign as ed25519Sign } from 'node:crypto';
import {
  generateAttesterKeyPair,
  signExecutionAttestation,
  computeExecutionDigest,
  executionValueCommitment,
  verifyAttestation,
  deriveAttesterKeyId,
  deriveAttestationIdentity,
  canonicalJsonStringify,
  type ExecutionStatement,
  type ExecutionAttestation,
  type ReplayRegistry,
  type AttestationVerificationPolicy,
  type AssuranceLevel,
} from '../../../src/execution-attestation/index.js';
import { buildRunAttestationVerificationPolicy } from '../../../src/workflow-runs/internal/attestation-boundary.js';
import type { WorkflowRun } from '../../../src/workflow-runs/index.js';

const RUN: Pick<
  WorkflowRun,
  'id' | 'workflowId' | 'versionId' | 'versionSemanticDigest' | 'installationId'
> = {
  id: 'wfr_0123456789abcdef0123456789abcdef',
  workflowId: 'wfw_0123456789abcdef0123456789abcdef',
  versionId: 'wfwv_0123456789abcdef0123456789abcdef',
  versionSemanticDigest: '571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37',
  installationId: 'wfin_0123456789abcdef0123456789abcdef',
};

const NOW = '2026-09-01T12:00:30.000Z';
const CURRENT_EPOCH = 7;
const EXECUTED_AT = '2026-09-01T12:00:00.000Z';
const VALID_UNTIL = '2026-09-01T12:05:00.000Z';
const ISSUED_AT = '2026-09-01T12:00:01.000Z';

function statementFor(overrides: Partial<ExecutionStatement> = {}): ExecutionStatement {
  return {
    objectType: 'workflowos/execution-statement/v1',
    statementSchemaVersion: 1,
    workflowId: RUN.workflowId,
    workflowVersionId: RUN.versionId,
    workflowVersionSemanticDigest: RUN.versionSemanticDigest,
    deploymentId: RUN.installationId as string,
    runId: RUN.id,
    attemptId: 1,
    stepId: 'notify_channel',
    nodeId: 'node_795e8b12eaef3e45',
    executionClass: 'deterministic_api',
    capability: 'messaging.send',
    action: 'Post the approved triage summary to the team notifications channel',
    inputCommitments: [executionValueCommitment('triage-input')],
    outputCommitments: [executionValueCommitment('triage-output')],
    observationCommitments: [executionValueCommitment('triage-observation')],
    evidenceReferences: ['wfre_0123456789abcdef0123456789abcdef'],
    causalParents: [],
    nonce: 'challenge-triage-run-0001-attempt-1',
    epoch: CURRENT_EPOCH,
    outcome: 'succeeded',
    executedAt: EXECUTED_AT,
    validUntil: VALID_UNTIL,
    ...overrides,
  } as ExecutionStatement;
}

/** A simple in-memory replay registry (the reference port composition). */
function fakeReplayRegistry(): ReplayRegistry {
  const consumed = new Set<string>();
  return {
    isConsumed: (binding) => consumed.has(`${binding.runId}:${binding.attemptId}:${binding.nonce}`),
    consume: (binding) => {
      consumed.add(`${binding.runId}:${binding.attemptId}:${binding.nonce}`);
    },
  };
}

function signed(statement: ExecutionStatement, assurance: AssuranceLevel = 'software_signed') {
  const key = generateAttesterKeyPair();
  return signExecutionAttestation({
    statement,
    attesterPrivateKey: key.privateKey,
    attesterPublicKeyDer: key.publicKeyDer,
    assurance,
    issuedAt: ISSUED_AT,
  });
}

/**
 * A FOREIGN producer's envelope: a REAL, correctly-computed Ed25519
 * signature over the canonical unsigned-envelope preimage, but claiming
 * `hardware_backed` with NO representable assurance evidence. The merged
 * signer refuses to produce this shape (fail-closed at the source); a foreign
 * signer of the same protocol can — the verifier must reject it.
 */
function foreignSignedClaimingHardwareWithoutEvidence(statement: ExecutionStatement): ExecutionAttestation {
  const key = generateAttesterKeyPair();
  const executionDigest = computeExecutionDigest(statement);
  const attesterKeyId = deriveAttesterKeyId(key.publicKeyDer);
  const unsigned = {
    objectType: 'workflowos/execution-attestation/v1',
    envelopeSchemaVersion: 1,
    attestationId: deriveAttestationIdentity(executionDigest.digest, attesterKeyId),
    executionDigest,
    statement,
    attesterKeyId,
    attesterPublicKey: key.publicKeyDer,
    assurance: 'hardware_backed',
    issuedAt: ISSUED_AT,
  };
  const preimage = canonicalJsonStringify(unsigned);
  const signature = ed25519Sign(null, Buffer.from(preimage, 'utf8'), key.privateKey).toString('hex');
  return { ...unsigned, signature } as unknown as ExecutionAttestation;
}

function policyWith(
  registry: ReplayRegistry,
  extra: {
    now?: string;
    currentEpoch?: number;
    maxAgeMs?: number;
    requiredAssurance?: AssuranceLevel;
    trustedAttesterKeyIds?: string[];
    stepId?: string;
  } = {},
): AttestationVerificationPolicy {
  return buildRunAttestationVerificationPolicy(
    RUN,
    {
      attemptNumber: 1,
      stepId: extra.stepId ?? 'notify_channel',
      policy: {
        maxAgeMs: extra.maxAgeMs,
        requiredAssurance: extra.requiredAssurance,
        trustedAttesterKeyIds: extra.trustedAttesterKeyIds,
      },
    },
    { now: extra.now ?? NOW, currentEpoch: extra.currentEpoch ?? CURRENT_EPOCH, replayRegistry: registry },
  );
}

describe('V2-005 — the run-boundary verification policy (consumes V2-014 verbatim)', () => {
  it('binds the verifier to the EXACT run/attempt/step/version semantics', () => {
    const registry = fakeReplayRegistry();
    const policy = policyWith(registry);
    expect(policy.bindings).toMatchObject({
      workflowId: RUN.workflowId,
      workflowVersionId: RUN.versionId,
      workflowVersionSemanticDigest: RUN.versionSemanticDigest,
      deploymentId: RUN.installationId,
      runId: RUN.id,
      attemptId: 1,
      stepId: 'notify_channel',
    });
    expect(policy.freshness.now).toBe(NOW);
    expect(policy.freshness.currentEpoch).toBe(CURRENT_EPOCH);
    expect(policy.freshness.replayRegistry).toBe(registry);
  });

  it('the pinned semantic digest expectation is the run pin, not a recomputation', () => {
    const policy = policyWith(fakeReplayRegistry());
    expect(policy.bindings.workflowVersionSemanticDigest).toBe(RUN.versionSemanticDigest);
  });

  it('a REAL correctly-bound attestation verifies through the boundary policy', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor());
    const result = verifyAttestation(attestation, policyWith(registry));
    expect(result.ok).toBe(true);
  });

  it('an attestation bound to ANOTHER run is typed-rejected (dimension run)', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor({ runId: 'wfr_deadbeefdeadbeefdeadbeefdeadbeef' }));
    const result = verifyAttestation(attestation, policyWith(registry));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(result.failure.dimension).toBe('run');
    }
  });

  it('an attestation bound to ANOTHER attempt is typed-rejected (dimension attempt)', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor({ attemptId: 2 }));
    const result = verifyAttestation(attestation, policyWith(registry));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(result.failure.dimension).toBe('attempt');
    }
  });

  it('an attestation bound to ANOTHER step is typed-rejected (dimension step)', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor({ stepId: 'fetch_issue' }));
    const result = verifyAttestation(attestation, policyWith(registry));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(result.failure.dimension).toBe('step');
    }
  });

  it('an attestation bound to a DIFFERENT workflow version is typed-rejected', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor({ workflowVersionId: 'wfwv_deadbeefdeadbeefdeadbeefdeadbeef' }));
    const result = verifyAttestation(attestation, policyWith(registry));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(result.failure.dimension).toBe('workflowVersion');
    }
  });

  it('a MODIFIED statement (mutated byte) fails digest/signature verification', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor());
    const modified: typeof attestation = {
      ...attestation,
      statement: { ...attestation.statement, action: 'Post the MUTATED summary to the channel' },
    };
    const result = verifyAttestation(modified, policyWith(registry));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['ATTESTATION_DIGEST_MISMATCH', 'ATTESTATION_SIGNATURE_INVALID']).toContain(result.failure.code);
    }
  });

  it('a STALE attestation (validity expired) is typed-rejected', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor());
    const latePolicy = policyWith(registry, { now: '2026-09-01T12:06:00.000Z' });
    const result = verifyAttestation(attestation, latePolicy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_EXPIRED');
    }
  });

  it('a REPLAYED attestation is typed-rejected (single-use nonce consumed)', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor());
    const policy = policyWith(registry);
    const first = verifyAttestation(attestation, policy);
    expect(first.ok).toBe(true);
    const second = verifyAttestation(attestation, policy);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure.code).toBe('ATTESTATION_REPLAYED');
    }
  });

  it('a VALID signature with INSUFFICIENT assurance is NOT accepted (never auto-proof)', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor());
    const policy = policyWith(registry, { requiredAssurance: 'hardware_backed' });
    const result = verifyAttestation(attestation, policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ASSURANCE_INSUFFICIENT');
    }
  });

  it('an attestation claiming hardware_backed WITHOUT representable evidence is rejected', () => {
    const registry = fakeReplayRegistry();
    // The merged signer refuses to sign this shape; a FOREIGN producer of the
    // same protocol can emit it with a REAL signature — the verifier (and
    // therefore the run boundary) must still fail closed on it.
    const attestation = foreignSignedClaimingHardwareWithoutEvidence(statementFor());
    const result = verifyAttestation(attestation, policyWith(registry));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ASSURANCE_EVIDENCE_MISSING');
    }
  });

  it('an UNTRUSTED attester is typed-rejected (cryptographic authenticity is not attester trust)', () => {
    const registry = fakeReplayRegistry();
    const attestation = signed(statementFor());
    const otherKey = generateAttesterKeyPair();
    const policy = policyWith(registry, { trustedAttesterKeyIds: [otherKey.keyId] });
    const result = verifyAttestation(attestation, policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ATTESTER_UNEXPECTED');
    }
  });

  it('the statement digest is stable across the boundary (run pins do not alter V2-014 digests)', () => {
    const statement = statementFor();
    const digest = computeExecutionDigest(statement);
    expect(digest.domain).toBe('workflowos/execution-statement/v1');
    expect(digest.algorithm).toBe('sha-256');
    expect(digest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeExecutionDigest(statementFor()).digest).toBe(digest.digest);
  });
});

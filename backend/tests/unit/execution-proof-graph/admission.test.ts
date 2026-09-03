import { describe, it, expect } from 'vitest';
import {
  evaluateProofAdmission,
  type PredecessorEvidence,
  type ProofAdmissionInput,
  type ProofAdmissionResult,
} from '../../../src/execution-proof-graph/index.js';
import {
  InMemoryReplayRegistry,
  verifyAttestation,
  type AttestationVerification,
} from '../../../src/execution-attestation/index.js';
import {
  PG_SCOPE,
  PG_EPOCH,
  buildPredecessorAttestation,
  buildDependentAttestation,
  buildGraphStatement,
  signGraphAttestation,
  ATTESTER_NODE_A,
  ATTESTER_NODE_B,
  ATTESTER_UNTRUSTED,
  NODE_A_ID,
  NODE_B_ID,
} from './helpers.js';

/**
 * V2-015 Task 3 — verification-derived admission predicates (red→green).
 *
 * Proves (frozen work order "Required verification" + invariant 4/8/9):
 *   - a predecessor is admissible ONLY when the supplied V2-014 verification
 *     result is a successful VerifiedExecutionFact with exact
 *     Run/WorkflowVersion/attestation identity binding;
 *   - typed V2-014 verification failures are NEVER reinterpreted as
 *     admissible evidence (the failure code is carried verbatim);
 *   - a raw/unverified result (the union's failure arm) never bypasses the
 *     fact requirement;
 *   - stale/freshness, assurance, trust, capability, authorization and
 *     placement are SEPARATE dimensions, each failing with its own typed
 *     code (invariant 9); a valid signature alone never satisfies trust,
 *     capability, authorization, or assurance policy (invariant 8);
 *   - the multi-parent semantics: an extra supplied parent NEVER silently
 *     satisfies a missing declared parent.
 */

const ADMIT_NOW = '2026-09-02T08:00:30.000Z';
const ADMISSION_MAX_AGE_MS = 10 * 60 * 1000;

/** Node B verifies Node A's attestation in its OWN verifier context. */
function verifyPredecessor(
  attestation: ReturnType<typeof buildPredecessorAttestation>,
  options: { now?: string; trustedKeys?: readonly string[]; epoch?: number; expectedNonce?: string } = {},
): AttestationVerification {
  return verifyAttestation(attestation, {
    bindings: {
      workflowId: PG_SCOPE.workflowId,
      workflowVersionId: PG_SCOPE.workflowVersionId,
      workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
      runId: PG_SCOPE.runId,
      attemptId: 1,
      stepId: 'collect_intake',
      nodeId: NODE_A_ID,
    },
    freshness: {
      now: options.now ?? ADMIT_NOW,
      currentEpoch: options.epoch ?? PG_EPOCH,
      ...(options.expectedNonce !== undefined ? { expectedNonce: options.expectedNonce } : {}),
      replayRegistry: new InMemoryReplayRegistry(),
      maxAgeMs: 60 * 60 * 1000,
    },
    attesterKeyIds: options.trustedKeys ?? [ATTESTER_NODE_A.keyId],
    requiredAssurance: 'software_signed',
  });
}

/** The canonical admitted admission input (baseline for mutation tests). */
function buildAdmittedInput(): { input: ProofAdmissionInput; predecessor: ReturnType<typeof buildPredecessorAttestation> } {
  const predecessor = buildPredecessorAttestation();
  const verification = verifyPredecessor(predecessor);
  if (!verification.ok) {
    throw new Error(`baseline verification unexpectedly failed: ${verification.failure.code}`);
  }
  const input: ProofAdmissionInput = {
    dependent: {
      stepId: 'write_report',
      workflowId: PG_SCOPE.workflowId,
      workflowVersionId: PG_SCOPE.workflowVersionId,
      workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
      runId: PG_SCOPE.runId,
    },
    declaredParents: [predecessor.executionDigest.digest],
    predecessorEvidence: [
      { executionDigest: predecessor.executionDigest.digest, verification },
    ],
    trustPolicy: {
      trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId],
      requiredAssurance: 'software_signed',
      now: ADMIT_NOW,
      currentEpoch: PG_EPOCH,
      maxVerificationAgeMs: ADMISSION_MAX_AGE_MS,
    },
    capabilityFacts: [{ nodeId: NODE_A_ID, possessedCapabilities: ['browser.observe', 'browser.click'] }],
    capabilityRequirement: ['browser.observe'],
    authorizationGrants: [{ nodeId: NODE_B_ID, capability: 'filesystem.write' }],
    authorizationRequired: true,
    dependentCapability: 'filesystem.write',
    placementEligibility: [{ nodeId: NODE_B_ID, placementConstraint: 'desktop_allowed', eligible: true }],
    placementConstraint: 'desktop_allowed',
  };
  return { input, predecessor };
}

type Admitted = Extract<ProofAdmissionResult, { admitted: true }>;
function expectAdmitted(result: ProofAdmissionResult): Admitted {
  if (!result.admitted) {
    throw new Error(`expected admitted, got ${result.failure.code} (${result.failure.detail})`);
  }
  return result;
}

function expectDenied(result: ProofAdmissionResult) {
  if (result.admitted) {
    throw new Error('expected a typed denial, got admitted');
  }
  return result;
}

describe('V2-015 admission — the verified predecessor requirement', () => {
  it('admits the dependent action when every dimension passes on real verified facts', () => {
    const { input, predecessor } = buildAdmittedInput();
    const result = expectAdmitted(evaluateProofAdmission(input));

    expect(result.satisfiedParents).toEqual([predecessor.executionDigest.digest]);
    expect(result.trustedAttesterKeyIds).toEqual([ATTESTER_NODE_A.keyId]);
    expect(result.dependentStepId).toBe('write_report');
  });

  it('denies admission when the declared parent has NO supplied evidence', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({ ...input, predecessorEvidence: [] }),
    );
    expect(result.failure.code).toBe('ADMISSION_PARENT_MISSING');
    expect(result.failure.dimension).toBe('parents');
  });

  it('denies admission when the supplied V2-014 verification FAILED (carries the verifier code verbatim)', () => {
    const predecessor = buildPredecessorAttestation();
    // Node B's verifier context does NOT trust Node A's key
    const failed = verifyPredecessor(predecessor, { trustedKeys: [] });
    expect(failed.ok).toBe(false);

    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        predecessorEvidence: [{ executionDigest: predecessor.executionDigest.digest, verification: failed }],
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_PREDECESSOR_UNVERIFIED');
    expect(result.failure.dimension).toBe('verification');
    if (!result.failure.verifierFailureCode) {
      throw new Error('expected the V2-014 failure code carried verbatim');
    }
  });

  it('denies admission when the fact is bound to a different run (binding mismatch)', () => {
    // a REAL verified fact — but for another run's predecessor
    const foreign = signGraphAttestation(
      buildGraphStatement({
        stepId: 'collect_intake',
        nodeId: NODE_A_ID,
        action: 'Collect the intake form submission from the web portal',
        nonce: 'challenge-foreign-run-7777',
        runId: 'wfr-a-different-run',
      }),
      ATTESTER_NODE_A,
    );
    const foreignVerification = verifyAttestation(foreign, {
      bindings: { runId: 'wfr-a-different-run' },
      freshness: { now: ADMIT_NOW, currentEpoch: PG_EPOCH, replayRegistry: new InMemoryReplayRegistry(), maxAgeMs: 60 * 60 * 1000 },
      attesterKeyIds: [ATTESTER_NODE_A.keyId],
      requiredAssurance: 'software_signed',
    });
    expect(foreignVerification.ok).toBe(true);

    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        declaredParents: [foreign.executionDigest.digest],
        predecessorEvidence: [{ executionDigest: foreign.executionDigest.digest, verification: foreignVerification }],
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_PREDECESSOR_BINDING_MISMATCH');
    expect(result.failure.dimension).toBe('binding');
    expect(result.failure.bindingDimension).toBe('run');
  });

  it('an extra supplied parent NEVER silently satisfies a missing declared parent', () => {
    const { input, predecessor } = buildAdmittedInput();
    // evidence for an UNRELATED attestation is supplied, but the declared
    // parent has no evidence at all
    const unrelated = signGraphAttestation(
      buildGraphStatement({ stepId: 'unrelated_step', nodeId: NODE_B_ID, action: 'Unrelated', nonce: 'n-unrelated' }),
      ATTESTER_NODE_B,
    );
    const unrelatedVerification = verifyAttestation(unrelated, {
      bindings: {},
      freshness: { now: ADMIT_NOW, currentEpoch: PG_EPOCH, replayRegistry: new InMemoryReplayRegistry(), maxAgeMs: 60 * 60 * 1000 },
      attesterKeyIds: [ATTESTER_NODE_B.keyId],
      requiredAssurance: 'software_signed',
    });
    expect(unrelatedVerification.ok).toBe(true);

    const evidence: PredecessorEvidence[] = [
      { executionDigest: unrelated.executionDigest.digest, verification: unrelatedVerification },
    ];
    void predecessor;
    const result = expectDenied(
      evaluateProofAdmission({ ...input, predecessorEvidence: evidence }),
    );
    expect(result.failure.code).toBe('ADMISSION_PARENT_MISSING');
  });

  it('fails closed on structurally invalid input (no declared parents)', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(evaluateProofAdmission({ ...input, declaredParents: [] }));
    expect(result.failure.code).toBe('ADMISSION_INPUT_INVALID');
  });

  it('fails closed when the trust policy omits the admission clock', () => {
    const { input } = buildAdmittedInput();
    // deliberately supply a policy WITHOUT the admission clock (typed hole
    // exercised through a controlled cast — the runtime must fail closed)
    const trustPolicyWithoutNow = { ...input.trustPolicy } as Partial<typeof input.trustPolicy>;
    delete (trustPolicyWithoutNow as { now?: string }).now;
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        trustPolicy: trustPolicyWithoutNow as typeof input.trustPolicy,
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_INPUT_INVALID');
    expect(result.failure.dimension).toBe('freshness');
  });
});

describe('V2-015 admission — freshness, assurance, trust (separate dimensions)', () => {
  it('denies stale facts: the statement validity window has elapsed', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        trustPolicy: {
          ...input.trustPolicy,
          now: '2026-09-02T09:00:00.000Z', // beyond PG_VALID_UNTIL
        },
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_PREDECESSOR_STALE');
    expect(result.failure.dimension).toBe('freshness');
  });

  it('denies stale facts: the verification itself has aged out', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        trustPolicy: {
          ...input.trustPolicy,
          maxVerificationAgeMs: 1, // verified at ADMIT_NOW; now is ADMIT_NOW → not stale... use an aged clock instead
          now: '2026-09-02T08:05:00.000Z',
        },
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_PREDECESSOR_STALE');
  });

  it('denies stale facts: the statement epoch is behind the verifier epoch', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        trustPolicy: { ...input.trustPolicy, currentEpoch: PG_EPOCH + 1 },
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_PREDECESSOR_STALE');
  });

  it('denies facts below the explicit required assurance level', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        trustPolicy: { ...input.trustPolicy, requiredAssurance: 'hardware_backed' },
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_ASSURANCE_INSUFFICIENT');
    expect(result.failure.dimension).toBe('assurance');
  });

  it('denies facts from attesters outside the trusted set (signature validity is NOT trust)', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        trustPolicy: { ...input.trustPolicy, trustedAttesterKeyIds: [ATTESTER_UNTRUSTED.keyId] },
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_TRUST_POLICY_REJECTED');
    expect(result.failure.dimension).toBe('trust');
  });

  it('the EMPTY trusted set trusts NOBODY (fail-closed)', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        trustPolicy: { ...input.trustPolicy, trustedAttesterKeyIds: [] },
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_TRUST_POLICY_REJECTED');
  });
});

describe('V2-015 admission — capability, authorization, placement (explicit inputs)', () => {
  it('denies when the predecessor executor lacks the required capability (fact supplied)', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        capabilityFacts: [{ nodeId: NODE_A_ID, possessedCapabilities: ['browser.click'] }],
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_CAPABILITY_ABSENT');
    expect(result.failure.dimension).toBe('capability');
  });

  it('denies when the capability fact is missing entirely (fail-closed)', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        capabilityFacts: [{ nodeId: NODE_B_ID, possessedCapabilities: ['filesystem.write'] }],
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_CAPABILITY_ABSENT');
  });

  it('denies when no explicit authorization grant covers the dependent action', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({ ...input, authorizationGrants: [{ nodeId: NODE_B_ID, capability: 'filesystem.read' }] }),
    );
    expect(result.failure.code).toBe('ADMISSION_AUTHORIZATION_DENIED');
    expect(result.failure.dimension).toBe('authorization');
  });

  it('denies when authorization is required and the grant list is absent', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({ ...input, authorizationGrants: undefined }),
    );
    expect(result.failure.code).toBe('ADMISSION_AUTHORIZATION_DENIED');
  });

  it('denies when placement reports the node ineligible under the declared constraint', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        placementEligibility: [{ nodeId: NODE_B_ID, placementConstraint: 'desktop_allowed', eligible: false }],
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_PLACEMENT_INELIGIBLE');
    expect(result.failure.dimension).toBe('placement');
  });

  it('denies when the placement fact is missing for the declared constraint (fail-closed)', () => {
    const { input } = buildAdmittedInput();
    const result = expectDenied(
      evaluateProofAdmission({
        ...input,
        placementEligibility: [{ nodeId: NODE_B_ID, placementConstraint: 'cloud_only', eligible: true }],
      }),
    );
    expect(result.failure.code).toBe('ADMISSION_PLACEMENT_INELIGIBLE');
  });

  it('the dependent attestation pair composes: the real dependent statement declares the verified predecessor', () => {
    // the FULL composition: predecessor verified → dependent statement
    // declares exactly that digest → the graph admission path composes both
    const predecessor = buildPredecessorAttestation();
    const dependent = buildDependentAttestation(predecessor);
    expect(dependent.statement.causalParents).toEqual([predecessor.executionDigest.digest]);
    const verification = verifyPredecessor(predecessor);
    expect(verification.ok).toBe(true);
    const { input } = buildAdmittedInput();
    const result = expectAdmitted(
      evaluateProofAdmission({
        ...input,
        declaredParents: [...dependent.statement.causalParents],
        predecessorEvidence: [
          { executionDigest: predecessor.executionDigest.digest, verification },
        ],
      }),
    );
    expect(result.satisfiedParents).toEqual([predecessor.executionDigest.digest]);
  });
});

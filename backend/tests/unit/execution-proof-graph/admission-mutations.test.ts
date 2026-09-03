import { describe, it, expect } from 'vitest';
import {
  evaluateProofAdmission,
  type ProofAdmissionInput,
  type ProofAdmissionResult,
} from '../../../src/execution-proof-graph/index.js';
import { verifyAttestation, InMemoryReplayRegistry, type AttestationVerification } from '../../../src/execution-attestation/index.js';
import {
  PG_SCOPE,
  PG_EPOCH,
  buildPredecessorAttestation,
  buildGraphStatement,
  signGraphAttestation,
  ATTESTER_NODE_A,
  ATTESTER_NODE_B,
  NODE_A_ID,
  NODE_B_ID,
} from './helpers.js';

/**
 * V2-015 Task 3 — admission mutation/discrimination battery.
 *
 * For EVERY critical admission predicate, mutate EXACTLY ONE input
 * dimension at a time from the admitted baseline and prove:
 *   1. the mutation DENIES admission (never silently accepted);
 *   2. the denial carries the CORRECT dimension's typed code (a mutation of
 *      dimension X can never surface as — or be satisfied through —
 *      dimension Y).
 *
 * Mutated dimensions: Run, WorkflowVersion, semantic digest, predecessor
 * identity (parent digest), evidence identity binding (wrapper digest
 * substitution — the wrapper/fact identity binding), verification result,
 * freshness, assurance, trust, capability, authorization, placement.
 */

const ADMIT_NOW = '2026-09-02T08:00:30.000Z';

/**
 * A fixed, well-formed sha-256 hex that is NOT any fixture attestation's
 * execution digest — the substituted WRAPPER key for the identity-binding
 * (wrapper/fact substitution) experiments. All fixture digests derive from
 * real sha-256 over fixed canonical statements; this synthetic constant
 * equals none of them.
 */
const SUBSTITUTED_WRAPPER_DIGEST = '5f'.repeat(32);

function verifyBaseline(attestation: ReturnType<typeof buildPredecessorAttestation>): AttestationVerification {
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
    freshness: { now: ADMIT_NOW, currentEpoch: PG_EPOCH, replayRegistry: new InMemoryReplayRegistry(), maxAgeMs: 60 * 60 * 1000 },
    attesterKeyIds: [ATTESTER_NODE_A.keyId],
    requiredAssurance: 'software_signed',
  });
}

function baseline(): { input: ProofAdmissionInput; predecessor: ReturnType<typeof buildPredecessorAttestation> } {
  const predecessor = buildPredecessorAttestation();
  const verification = verifyBaseline(predecessor);
  if (!verification.ok) {
    throw new Error(`baseline verification failed: ${verification.failure.code}`);
  }
  return {
    predecessor,
    input: {
      dependent: {
        stepId: 'write_report',
        workflowId: PG_SCOPE.workflowId,
        workflowVersionId: PG_SCOPE.workflowVersionId,
        workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
        runId: PG_SCOPE.runId,
      },
      declaredParents: [predecessor.executionDigest.digest],
      predecessorEvidence: [{ executionDigest: predecessor.executionDigest.digest, verification }],
      trustPolicy: {
        trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId],
        requiredAssurance: 'software_signed',
        now: ADMIT_NOW,
        currentEpoch: PG_EPOCH,
        maxVerificationAgeMs: 10 * 60 * 1000,
      },
      capabilityFacts: [{ nodeId: NODE_A_ID, possessedCapabilities: ['browser.observe', 'browser.click'] }],
      capabilityRequirement: ['browser.observe'],
      authorizationGrants: [{ nodeId: NODE_B_ID, capability: 'filesystem.write' }],
      authorizationRequired: true,
      dependentCapability: 'filesystem.write',
      placementEligibility: [{ nodeId: NODE_B_ID, placementConstraint: 'desktop_allowed', eligible: true }],
      placementConstraint: 'desktop_allowed',
    },
  };
}

type Admitted = Extract<ProofAdmissionResult, { admitted: true }>;
function expectAdmitted(result: ProofAdmissionResult): Admitted {
  if (!result.admitted) {
    throw new Error(`expected admitted, got ${result.failure.code} (${result.failure.detail})`);
  }
  return result;
}

function expectDeniedCode(result: ProofAdmissionResult, code: string, dimension: string) {
  if (result.admitted) {
    throw new Error(`expected denial ${code}/${dimension}, got admitted`);
  }
  expect(result.failure.code).toBe(code);
  expect(result.failure.dimension).toBe(dimension);
}

/** The shared mutation harness: baseline → single-dimension mutation. */
function mutated(mutate: (input: ProofAdmissionInput) => ProofAdmissionInput): ProofAdmissionResult {
  const { input } = baseline();
  return evaluateProofAdmission(mutate(input));
}

describe('V2-015 admission mutation/discrimination battery', () => {
  it('control: the unmutated baseline is admitted', () => {
    const { input } = baseline();
    expectAdmitted(evaluateProofAdmission(input));
  });

  it('mutating the dependent Run binding → binding denial (not parents, not trust)', () => {
    expectDeniedCode(
      mutated((input) => ({ ...input, dependent: { ...input.dependent, runId: 'wfr-mutated-run' } })),
      'ADMISSION_PREDECESSOR_BINDING_MISMATCH',
      'binding',
    );
  });

  it('mutating the dependent WorkflowVersion binding → binding denial', () => {
    expectDeniedCode(
      mutated((input) => ({ ...input, dependent: { ...input.dependent, workflowVersionId: 'wfv-mutated-version' } })),
      'ADMISSION_PREDECESSOR_BINDING_MISMATCH',
      'binding',
    );
  });

  it('mutating the semantic digest binding → binding denial', () => {
    expectDeniedCode(
      mutated((input) => ({
        ...input,
        dependent: { ...input.dependent, workflowVersionSemanticDigest: '0'.repeat(64) },
      })),
      'ADMISSION_PREDECESSOR_BINDING_MISMATCH',
      'binding',
    );
  });

  it('mutating the predecessor identity (declared parent digest) → missing parent (not unverified)', () => {
    expectDeniedCode(
      mutated((input) => ({ ...input, declaredParents: ['9'.repeat(64)] })),
      'ADMISSION_PARENT_MISSING',
      'parents',
    );
  });

  it('mutating the verification result to the failure arm → unverified (the V2-014 code carried)', () => {
    const predecessor = buildPredecessorAttestation();
    const failed = verifyAttestation(predecessor, {
      bindings: {},
      freshness: { now: ADMIT_NOW, currentEpoch: PG_EPOCH, replayRegistry: new InMemoryReplayRegistry(), maxAgeMs: 60 * 60 * 1000 },
      attesterKeyIds: [], // trusts nobody → typed verifier failure
      requiredAssurance: 'software_signed',
    });
    expect(failed.ok).toBe(false);
    expectDeniedCode(
      mutated((input) => ({
        ...input,
        predecessorEvidence: [{ executionDigest: input.declaredParents[0]!, verification: failed }],
      })),
      'ADMISSION_PREDECESSOR_UNVERIFIED',
      'verification',
    );
  });

  it('mutating freshness beyond the statement validity → stale (not trust, not assurance)', () => {
    expectDeniedCode(
      mutated((input) => ({ ...input, trustPolicy: { ...input.trustPolicy, now: '2026-09-02T09:00:00.000Z' } })),
      'ADMISSION_PREDECESSOR_STALE',
      'freshness',
    );
  });

  it('mutating the verifier epoch forward → stale (epoch discrimination)', () => {
    expectDeniedCode(
      mutated((input) => ({ ...input, trustPolicy: { ...input.trustPolicy, currentEpoch: PG_EPOCH + 5 } })),
      'ADMISSION_PREDECESSOR_STALE',
      'freshness',
    );
  });

  it('mutating freshness via verification age → stale (verifiedAt aging)', () => {
    expectDeniedCode(
      mutated((input) => ({
        ...input,
        trustPolicy: { ...input.trustPolicy, now: '2026-09-02T08:20:00.000Z' },
      })),
      'ADMISSION_PREDECESSOR_STALE',
      'freshness',
    );
  });

  it('mutating the required assurance upward → assurance denial (not trust)', () => {
    expectDeniedCode(
      mutated((input) => ({ ...input, trustPolicy: { ...input.trustPolicy, requiredAssurance: 'tee_attested' } })),
      'ADMISSION_ASSURANCE_INSUFFICIENT',
      'assurance',
    );
  });

  it('mutating the trusted set to exclude the attester → trust denial (not assurance)', () => {
    expectDeniedCode(
      mutated((input) => ({ ...input, trustPolicy: { ...input.trustPolicy, trustedAttesterKeyIds: [ATTESTER_NODE_B.keyId] } })),
      'ADMISSION_TRUST_POLICY_REJECTED',
      'trust',
    );
  });

  it('mutating the capability fact to lack the capability → capability denial (not authorization)', () => {
    expectDeniedCode(
      mutated((input) => ({
        ...input,
        capabilityFacts: [{ nodeId: NODE_A_ID, possessedCapabilities: ['browser.click'] }],
      })),
      'ADMISSION_CAPABILITY_ABSENT',
      'capability',
    );
  });

  it('mutating the capability fact to the wrong node → capability denial (fail-closed)', () => {
    expectDeniedCode(
      mutated((input) => ({
        ...input,
        capabilityFacts: [{ nodeId: NODE_B_ID, possessedCapabilities: ['browser.observe'] }],
      })),
      'ADMISSION_CAPABILITY_ABSENT',
      'capability',
    );
  });

  it('mutating the authorization grant to a different capability → authorization denial (not capability)', () => {
    expectDeniedCode(
      mutated((input) => ({
        ...input,
        authorizationGrants: [{ nodeId: NODE_B_ID, capability: 'filesystem.read' }],
      })),
      'ADMISSION_AUTHORIZATION_DENIED',
      'authorization',
    );
  });

  it('mutating the placement fact to ineligible → placement denial (not authorization)', () => {
    expectDeniedCode(
      mutated((input) => ({
        ...input,
        placementEligibility: [{ nodeId: NODE_B_ID, placementConstraint: 'desktop_allowed', eligible: false }],
      })),
      'ADMISSION_PLACEMENT_INELIGIBLE',
      'placement',
    );
  });

  it('mutating placement to a different constraint id → placement denial (constraint discrimination)', () => {
    expectDeniedCode(
      mutated((input) => ({
        ...input,
        placementEligibility: [{ nodeId: NODE_B_ID, placementConstraint: 'cloud_only', eligible: true }],
      })),
      'ADMISSION_PLACEMENT_INELIGIBLE',
      'placement',
    );
  });

  it('wrapper/fact identity substitution (the attack shape): the SAME verified fact retained under a SUBSTITUTED wrapper digest, declared parent following the wrapper → evidence identity mismatch', () => {
    // THE SUBSTITUTION VECTOR (architect review, PR #158 Blocker 1): a
    // genuinely verified fact for digest B is paired with
    // PredecessorEvidence.executionDigest = A and the parent set declares A.
    // The wrapper key satisfies the parent lookup while binding/freshness/
    // assurance/trust are evaluated from the retained fact — without the
    // explicit identity binding this ADMITS the dependent with a
    // satisfiedParents entry that was never the digest of a verified fact.
    const { input } = baseline();
    const verification = input.predecessorEvidence[0]!.verification; // the retained verified fact
    const result = evaluateProofAdmission({
      ...input,
      declaredParents: [SUBSTITUTED_WRAPPER_DIGEST],
      predecessorEvidence: [{ executionDigest: SUBSTITUTED_WRAPPER_DIGEST, verification }],
    });
    expectDeniedCode(result, 'ADMISSION_EVIDENCE_IDENTITY_MISMATCH', 'verification');
    if (!result.admitted) {
      expect(result.failure.parentDigest).toBe(SUBSTITUTED_WRAPPER_DIGEST);
    }
  });

  it('wrapper digest substituted ALONE (declared parents unchanged, same retained fact) → evidence identity mismatch BEFORE the parent lookup', () => {
    // The purest single-dimension mutation: ONLY the wrapper digest is
    // substituted, the verified fact is retained, the declared parent set
    // is unchanged. The denial must carry the identity-mismatch code — NOT
    // ADMISSION_PARENT_MISSING — proving the binding fires in the
    // structural phase, before the wrapper-key map lookup is consulted.
    const { input } = baseline();
    const verification = input.predecessorEvidence[0]!.verification;
    const result = evaluateProofAdmission({
      ...input,
      predecessorEvidence: [{ executionDigest: SUBSTITUTED_WRAPPER_DIGEST, verification }],
    });
    expectDeniedCode(result, 'ADMISSION_EVIDENCE_IDENTITY_MISMATCH', 'verification');
  });

  it('a malformed fact shape (executionDigest.digest absent) under the matching wrapper key → evidence identity mismatch (fail-closed on malformed)', () => {
    // The comparison is fail-closed against malformed runtime data: a fact
    // whose OWN executionDigest.digest is absent never equals the wrapper
    // key — typed denial, never a crash and never a silent pass.
    const { input } = baseline();
    const verification = input.predecessorEvidence[0]!.verification;
    if (!verification.ok) {
      throw new Error('baseline verification must be ok for this experiment');
    }
    const hollowFact = { ...verification.fact, executionDigest: undefined } as unknown as typeof verification.fact;
    const result = evaluateProofAdmission({
      ...input,
      predecessorEvidence: [
        { executionDigest: input.predecessorEvidence[0]!.executionDigest, verification: { ok: true, fact: hollowFact } },
      ],
    });
    expectDeniedCode(result, 'ADMISSION_EVIDENCE_IDENTITY_MISMATCH', 'verification');
  });

  it('substituting a DIFFERENT verified predecessor (same scope) → missing parent for the declared digest', () => {
    // the mutation is the PARENT IDENTITY: a different attestation, real and
    // verified, bound to the same scope — but the declared parent digest
    // no longer matches the supplied evidence digest
    const other = signGraphAttestation(
      buildGraphStatement({
        stepId: 'collect_intake',
        nodeId: NODE_A_ID,
        action: 'Collect the intake form submission from the web portal (retry)',
        nonce: 'challenge-cdr-run-0001-step-collect-retry-x',
      }),
      ATTESTER_NODE_A,
    );
    const otherVerification = verifyAttestation(other, {
      bindings: {},
      freshness: { now: ADMIT_NOW, currentEpoch: PG_EPOCH, replayRegistry: new InMemoryReplayRegistry(), maxAgeMs: 60 * 60 * 1000 },
      attesterKeyIds: [ATTESTER_NODE_A.keyId],
      requiredAssurance: 'software_signed',
    });
    expect(otherVerification.ok).toBe(true);
    expectDeniedCode(
      mutated((input) => ({
        ...input,
        predecessorEvidence: [{ executionDigest: other.executionDigest.digest, verification: otherVerification }],
      })),
      'ADMISSION_PARENT_MISSING',
      'parents',
    );
  });

  it('the multi-parent mutation: dropping ONE of TWO declared parents → missing parent', () => {
    const { predecessor, input } = baseline();
    const secondParent = signGraphAttestation(
      buildGraphStatement({
        stepId: 'second_parent_step',
        nodeId: NODE_B_ID,
        action: 'A second predecessor the dependent action also relies on',
        nonce: 'n-second-parent',
      }),
      ATTESTER_NODE_B,
    );
    const secondVerification = verifyAttestation(secondParent, {
      bindings: {},
      freshness: { now: ADMIT_NOW, currentEpoch: PG_EPOCH, replayRegistry: new InMemoryReplayRegistry(), maxAgeMs: 60 * 60 * 1000 },
      attesterKeyIds: [ATTESTER_NODE_B.keyId],
      requiredAssurance: 'software_signed',
    });
    expect(secondVerification.ok).toBe(true);

    // full two-parent set is admitted (with both facts trusted + both
    // executors' capability facts)
    const twoParentInput: ProofAdmissionInput = {
      ...input,
      declaredParents: [predecessor.executionDigest.digest, secondParent.executionDigest.digest].sort(),
      predecessorEvidence: [
        { executionDigest: predecessor.executionDigest.digest, verification: input.predecessorEvidence[0]!.verification },
        { executionDigest: secondParent.executionDigest.digest, verification: secondVerification },
      ],
      trustPolicy: {
        ...input.trustPolicy,
        trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
      },
      capabilityFacts: [
        { nodeId: NODE_A_ID, possessedCapabilities: ['browser.observe', 'browser.click'] },
        { nodeId: NODE_B_ID, possessedCapabilities: ['browser.observe', 'filesystem.write', 'filesystem.read'] },
      ],
    };
    expectAdmitted(evaluateProofAdmission(twoParentInput));

    // dropping the second parent's EVIDENCE (keeping both declared) denies
    expectDeniedCode(
      evaluateProofAdmission({
        ...twoParentInput,
        predecessorEvidence: twoParentInput.predecessorEvidence.slice(0, 1),
      }),
      'ADMISSION_PARENT_MISSING',
      'parents',
    );

    // keeping only the second parent's evidence but declaring both denies
    expectDeniedCode(
      evaluateProofAdmission({
        ...twoParentInput,
        predecessorEvidence: twoParentInput.predecessorEvidence.slice(1),
      }),
      'ADMISSION_PARENT_MISSING',
      'parents',
    );
  });

  it('ordering of the same parent set never changes the result (determinism)', () => {
    const { predecessor, input } = baseline();
    const secondParent = signGraphAttestation(
      buildGraphStatement({
        stepId: 'second_parent_step_b',
        nodeId: NODE_B_ID,
        action: 'Another second predecessor',
        nonce: 'n-second-parent-b',
      }),
      ATTESTER_NODE_B,
    );
    const secondVerification = verifyAttestation(secondParent, {
      bindings: {},
      freshness: { now: ADMIT_NOW, currentEpoch: PG_EPOCH, replayRegistry: new InMemoryReplayRegistry(), maxAgeMs: 60 * 60 * 1000 },
      attesterKeyIds: [ATTESTER_NODE_B.keyId],
      requiredAssurance: 'software_signed',
    });
    const digests = [predecessor.executionDigest.digest, secondParent.executionDigest.digest];
    const evidence = [
      { executionDigest: digests[0]!, verification: input.predecessorEvidence[0]!.verification },
      { executionDigest: digests[1]!, verification: secondVerification },
    ];
    const policy = {
      ...input.trustPolicy,
      trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
    };
    const capabilityFacts = [
      { nodeId: NODE_A_ID, possessedCapabilities: ['browser.observe', 'browser.click'] },
      { nodeId: NODE_B_ID, possessedCapabilities: ['browser.observe', 'filesystem.write', 'filesystem.read'] },
    ];

    const forward = evaluateProofAdmission({
      ...input,
      declaredParents: [...digests].sort(),
      predecessorEvidence: evidence,
      trustPolicy: policy,
      capabilityFacts,
    });
    const reverse = evaluateProofAdmission({
      ...input,
      declaredParents: [...digests].sort().reverse(),
      predecessorEvidence: [...evidence].reverse(),
      trustPolicy: policy,
      capabilityFacts,
    });
    const forwardAdmitted = expectAdmitted(forward);
    const reverseAdmitted = expectAdmitted(reverse);
    expect(forwardAdmitted.satisfiedParents).toEqual(reverseAdmitted.satisfiedParents);
  });

  it('mutated dependent capability WITHOUT a covering grant → authorization denial', () => {
    expectDeniedCode(
      mutated((input) => ({ ...input, dependentCapability: 'filesystem.read' })),
      'ADMISSION_AUTHORIZATION_DENIED',
      'authorization',
    );
  });
});

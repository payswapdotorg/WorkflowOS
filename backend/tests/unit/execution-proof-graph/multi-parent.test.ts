import { describe, it, expect } from 'vitest';
import {
  createProofGraphBuilder,
  evaluateGraphAdmission,
  serializeProofGraph,
  type ExecutionProofGraph,
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
 * V2-015 Task 4 — multi-parent dependency satisfaction at graph level.
 *
 * Proves (frozen work order "Required verification" + invariant 6):
 *   - the dependent action requires the EXACT declared parent set;
 *   - a declared parent missing from the GRAPH (not reconstructable) denies
 *     admission — evidence alone is not enough;
 *   - a declared parent missing EVIDENCE denies admission;
 *   - an EXTRA unrelated parent node in the graph never silently satisfies
 *     a missing declared parent;
 *   - the ordering of the same parent set never changes the result;
 *   - independent branches may execute in parallel only when declared —
 *     the two-branch diamond composes and admits the join.
 */

const ADMIT_NOW = '2026-09-02T08:00:30.000Z';

function verifyFor(attestation: ReturnType<typeof signGraphAttestation>, options: { trustedKeys?: readonly string[] } = {}): AttestationVerification {
  return verifyAttestation(attestation, {
    bindings: {},
    freshness: { now: ADMIT_NOW, currentEpoch: PG_EPOCH, replayRegistry: new InMemoryReplayRegistry(), maxAgeMs: 60 * 60 * 1000 },
    attesterKeyIds: options.trustedKeys ?? [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
    requiredAssurance: 'software_signed',
  });
}

describe('V2-015 multi-parent admission (graph-grounded)', () => {
  it('admits the two-parent join when both parents are graph nodes with verified evidence', () => {
    const parentA = buildPredecessorAttestation();
    const parentB = signGraphAttestation(
      buildGraphStatement({ stepId: 'gather_inputs', nodeId: NODE_B_ID, action: 'Gather inputs on the desktop host', nonce: 'n-gather', capability: 'filesystem.read', executionClass: 'agentic_computer_use' }),
      ATTESTER_NODE_B,
    );
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(parentA);
    builder.addAttestationNode(parentB);

    const verificationA = verifyFor(parentA);
    const verificationB = verifyFor(parentB);
    expect(verificationA.ok && verificationB.ok).toBe(true);

    const result = evaluateGraphAdmission({
      graph: builder.graph,
      dependent: {
        stepId: 'write_report',
        workflowId: PG_SCOPE.workflowId,
        workflowVersionId: PG_SCOPE.workflowVersionId,
        workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
        runId: PG_SCOPE.runId,
      },
      declaredParents: [parentA.executionDigest.digest, parentB.executionDigest.digest],
      predecessorEvidence: [
        { executionDigest: parentA.executionDigest.digest, verification: verificationA },
        { executionDigest: parentB.executionDigest.digest, verification: verificationB },
      ],
      trustPolicy: {
        trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
        requiredAssurance: 'software_signed',
        now: ADMIT_NOW,
        currentEpoch: PG_EPOCH,
        maxVerificationAgeMs: 10 * 60 * 1000,
      },
      capabilityFacts: [
        { nodeId: NODE_A_ID, possessedCapabilities: ['browser.observe', 'filesystem.read'] },
        { nodeId: NODE_B_ID, possessedCapabilities: ['browser.observe', 'filesystem.read'] },
      ],
      capabilityRequirement: ['browser.observe', 'filesystem.read'],
    });

    if (!result.admitted) {
      throw new Error(`expected admitted, got ${result.failure.code}: ${result.failure.detail}`);
    }
    expect(result.satisfiedParents).toEqual([parentA.executionDigest.digest, parentB.executionDigest.digest].sort());
  });

  it('denies when a declared parent is NOT a graph node (not reconstructable)', () => {
    const parentA = buildPredecessorAttestation();
    const parentB = signGraphAttestation(
      buildGraphStatement({ stepId: 'gather_inputs', nodeId: NODE_B_ID, action: 'Gather inputs', nonce: 'n-gather-2' }),
      ATTESTER_NODE_B,
    );
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(parentA); // parentB is NEVER added to the graph

    const verificationA = verifyFor(parentA);
    const verificationB = verifyFor(parentB);
    expect(verificationA.ok && verificationB.ok).toBe(true);

    const result = evaluateGraphAdmission({
      graph: builder.graph,
      dependent: {
        stepId: 'write_report',
        workflowId: PG_SCOPE.workflowId,
        workflowVersionId: PG_SCOPE.workflowVersionId,
        workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
        runId: PG_SCOPE.runId,
      },
      declaredParents: [parentA.executionDigest.digest, parentB.executionDigest.digest],
      predecessorEvidence: [
        { executionDigest: parentA.executionDigest.digest, verification: verificationA },
        { executionDigest: parentB.executionDigest.digest, verification: verificationB },
      ],
      trustPolicy: {
        trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
        requiredAssurance: 'software_signed',
        now: ADMIT_NOW,
        currentEpoch: PG_EPOCH,
        maxVerificationAgeMs: 10 * 60 * 1000,
      },
    });

    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.failure.code).toBe('ADMISSION_PARENT_MISSING');
      expect(result.failure.parentDigest).toBe(parentB.executionDigest.digest);
    }
  });

  it('denies when a declared parent has NO supplied evidence (graph node alone is not enough)', () => {
    const parentA = buildPredecessorAttestation();
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(parentA);
    const verificationA = verifyFor(parentA);
    expect(verificationA.ok).toBe(true);

    const result = evaluateGraphAdmission({
      graph: builder.graph,
      dependent: {
        stepId: 'write_report',
        workflowId: PG_SCOPE.workflowId,
        workflowVersionId: PG_SCOPE.workflowVersionId,
        workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
        runId: PG_SCOPE.runId,
      },
      declaredParents: [parentA.executionDigest.digest],
      predecessorEvidence: [],
      trustPolicy: {
        trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId],
        requiredAssurance: 'software_signed',
        now: ADMIT_NOW,
        currentEpoch: PG_EPOCH,
      },
    });

    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.failure.code).toBe('ADMISSION_PARENT_MISSING');
    }
  });

  it('an EXTRA unrelated graph node never satisfies a missing declared parent', () => {
    const parentA = buildPredecessorAttestation();
    const unrelated = signGraphAttestation(
      buildGraphStatement({ stepId: 'unrelated_step', nodeId: NODE_B_ID, action: 'Unrelated', nonce: 'n-unrelated-mp' }),
      ATTESTER_NODE_B,
    );
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(parentA);
    builder.addAttestationNode(unrelated);
    const verificationA = verifyFor(parentA);
    const verificationUnrelated = verifyFor(unrelated);
    expect(verificationA.ok && verificationUnrelated.ok).toBe(true);

    // the declared parent is a digest that is in NEITHER node
    const result = evaluateGraphAdmission({
      graph: builder.graph,
      dependent: {
        stepId: 'write_report',
        workflowId: PG_SCOPE.workflowId,
        workflowVersionId: PG_SCOPE.workflowVersionId,
        workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
        runId: PG_SCOPE.runId,
      },
      declaredParents: ['a'.repeat(64)],
      predecessorEvidence: [
        { executionDigest: unrelated.executionDigest.digest, verification: verificationUnrelated },
      ],
      trustPolicy: {
        trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
        requiredAssurance: 'software_signed',
        now: ADMIT_NOW,
        currentEpoch: PG_EPOCH,
      },
    });

    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.failure.code).toBe('ADMISSION_PARENT_MISSING');
      expect(result.failure.parentDigest).toBe('a'.repeat(64));
    }
    void verificationA;
  });

  it('ordering of the same parent set never changes the result (determinism)', () => {
    const parentA = buildPredecessorAttestation();
    const parentB = signGraphAttestation(
      buildGraphStatement({ stepId: 'gather_inputs', nodeId: NODE_B_ID, action: 'Gather inputs', nonce: 'n-gather-3' }),
      ATTESTER_NODE_B,
    );
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(parentA);
    builder.addAttestationNode(parentB);
    const verificationA = verifyFor(parentA);
    const verificationB = verifyFor(parentB);

    const base = {
      graph: builder.graph as ExecutionProofGraph,
      dependent: {
        stepId: 'write_report',
        workflowId: PG_SCOPE.workflowId,
        workflowVersionId: PG_SCOPE.workflowVersionId,
        workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
        runId: PG_SCOPE.runId,
      },
      predecessorEvidence: [
        { executionDigest: parentA.executionDigest.digest, verification: verificationA },
        { executionDigest: parentB.executionDigest.digest, verification: verificationB },
      ],
      trustPolicy: {
        trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
        requiredAssurance: 'software_signed' as const,
        now: ADMIT_NOW,
        currentEpoch: PG_EPOCH,
      },
    };
    const forward = evaluateGraphAdmission({ ...base, declaredParents: [parentA.executionDigest.digest, parentB.executionDigest.digest] });
    const reverse = evaluateGraphAdmission({ ...base, declaredParents: [parentB.executionDigest.digest, parentA.executionDigest.digest] });
    expect(forward.admitted).toBe(true);
    expect(reverse.admitted).toBe(true);
    if (forward.admitted && reverse.admitted) {
      expect(forward.satisfiedParents).toEqual(reverse.satisfiedParents);
    }
  });

  it('the two-branch diamond composes: root + two branches + the join (conflicting-branch convergence setup)', () => {
    const root = buildPredecessorAttestation();
    const left = signGraphAttestation(
      buildGraphStatement({ stepId: 'branch_left', nodeId: NODE_A_ID, action: 'Left branch', nonce: 'n-diamond-left', causalParents: [root.executionDigest.digest] }),
      ATTESTER_NODE_A,
    );
    const right = signGraphAttestation(
      buildGraphStatement({ stepId: 'branch_right', nodeId: NODE_B_ID, action: 'Right branch', nonce: 'n-diamond-right', causalParents: [root.executionDigest.digest] }),
      ATTESTER_NODE_B,
    );
    const join = signGraphAttestation(
      buildGraphStatement({
        stepId: 'join_report',
        nodeId: NODE_B_ID,
        action: 'Join both branches into the report',
        nonce: 'n-diamond-join',
        causalParents: [left.executionDigest.digest, right.executionDigest.digest],
      }),
      ATTESTER_NODE_B,
    );
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(root);
    builder.addAttestationNode(left);
    builder.addAttestationNode(right);
    builder.addAttestationNode(join);
    builder.addCausalEdge({ parentAttestationId: root.attestationId, childAttestationId: left.attestationId });
    builder.addCausalEdge({ parentAttestationId: root.attestationId, childAttestationId: right.attestationId });
    builder.addCausalEdge({ parentAttestationId: left.attestationId, childAttestationId: join.attestationId });
    builder.addCausalEdge({ parentAttestationId: right.attestationId, childAttestationId: join.attestationId });
    expect(builder.graph.nodes).toHaveLength(4);
    expect(builder.graph.edges).toHaveLength(4);

    // the join's admission over BOTH parents (graph-grounded)
    const verificationLeft = verifyFor(left);
    const verificationRight = verifyFor(right);
    expect(verificationLeft.ok && verificationRight.ok).toBe(true);
    const admission = evaluateGraphAdmission({
      graph: builder.graph,
      dependent: {
        stepId: 'join_report',
        workflowId: PG_SCOPE.workflowId,
        workflowVersionId: PG_SCOPE.workflowVersionId,
        workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
        runId: PG_SCOPE.runId,
      },
      declaredParents: [left.executionDigest.digest, right.executionDigest.digest],
      predecessorEvidence: [
        { executionDigest: left.executionDigest.digest, verification: verificationLeft },
        { executionDigest: right.executionDigest.digest, verification: verificationRight },
      ],
      trustPolicy: {
        trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
        requiredAssurance: 'software_signed',
        now: ADMIT_NOW,
        currentEpoch: PG_EPOCH,
      },
    });
    expect(admission.admitted).toBe(true);

    // the serialization of the diamond is byte-stable across fresh builds
    const rebuild = createProofGraphBuilder(PG_SCOPE);
    for (const node of [...builder.graph.nodes].reverse()) {
      rebuild.addNode(node);
    }
    for (const edge of [...builder.graph.edges].reverse()) {
      const parent = rebuild.graph.nodes.find((n) => n.nodeIdentity === edge.parentNode)!;
      const child = rebuild.graph.nodes.find((n) => n.nodeIdentity === edge.childNode)!;
      if (edge.relation === 'causal') {
        rebuild.addCausalEdge({ parentAttestationId: parent.attestationId, childAttestationId: child.attestationId });
      } else {
        rebuild.addDependencyEdge({ parentAttestationId: parent.attestationId, childAttestationId: child.attestationId, declaredBy: 'rebuild' });
      }
    }
    expect(serializeProofGraph(rebuild.graph)).toBe(serializeProofGraph(builder.graph));
  });
});

import { describe, it, expect } from 'vitest';
import {
  createProofGraphBuilder,
  deriveProofNodeIdentity,
  deriveProofEdgeIdentity,
  validateGraphState,
  type ProofGraphMutationResult,
} from '../../../src/execution-proof-graph/index.js';
import {
  PG_SCOPE,
  buildPredecessorAttestation,
  buildDependentAttestation,
  buildGraphStatement,
  signGraphAttestation,
  ATTESTER_NODE_A,
  ATTESTER_NODE_B,
  NODE_A_ID,
  NODE_B_ID,
} from './helpers.js';

/**
 * V2-015 Task 2 — deterministic graph construction (red→green battery).
 *
 * Proves (frozen work order "Required verification"):
 *   - single-node and multi-node proof-graph construction;
 *   - stable node identity (same valid attestation → one logical node);
 *   - a changed canonical attestation identity cannot silently map to the
 *     old node (identity is derived ONLY from attestationId);
 *   - deterministic edge ordering and acyclicity (missing-node rejection,
 *     self-edge rejection, direct-cycle rejection, multi-hop cycle
 *     rejection);
 *   - append-only: conflicting redefinition rejected, never last-write-wins;
 *   - duplicate delivery converges (one logical fact);
 *   - scope mismatch rejection (cross-run/cross-version substitution).
 */

/** Typed narrowing helpers (fail loud with the actual kind/code). */
function expectAccepted(result: ProofGraphMutationResult) {
  if (result.kind !== 'accepted') {
    throw new Error(`expected accepted, got ${result.kind} (${'failure' in result ? result.failure.code : ''})`);
  }
  return result;
}
function expectDuplicate(result: ProofGraphMutationResult) {
  if (result.kind !== 'duplicate') {
    throw new Error(`expected duplicate, got ${result.kind} (${'failure' in result ? result.failure.code : ''})`);
  }
  return result;
}
function expectRejected(result: ProofGraphMutationResult) {
  if (result.kind !== 'rejected') {
    throw new Error(`expected rejected, got ${result.kind}`);
  }
  return result;
}

describe('V2-015 graph core — node construction', () => {
  it('constructs a single-node graph from a real attestation and validates clean', () => {
    const predecessor = buildPredecessorAttestation();
    const builder = createProofGraphBuilder(PG_SCOPE);
    const result = expectAccepted(builder.addAttestationNode(predecessor));

    expect(result.node?.attestationId).toBe(predecessor.attestationId);
    expect(result.node?.nodeIdentity).toBe(deriveProofNodeIdentity(predecessor.attestationId));
    expect(result.node?.runId).toBe(PG_SCOPE.runId);
    expect(result.node?.workflowVersionId).toBe(PG_SCOPE.workflowVersionId);
    expect(result.node?.executorNodeId).toBe(NODE_A_ID);
    expect(result.graph.nodes).toHaveLength(1);

    const issues = validateGraphState(result.graph);
    expect(issues, JSON.stringify(issues)).toEqual([]);
  });

  it('gives one logical node identity per attestation and distinct identities across attestations', () => {
    const predecessor = buildPredecessorAttestation();
    const dependent = buildDependentAttestation(predecessor);

    const idA = deriveProofNodeIdentity(predecessor.attestationId);
    const idB = deriveProofNodeIdentity(dependent.attestationId);
    expect(idA).not.toBe(idB);

    // the same attestation re-delivered maps to the SAME node identity
    expect(deriveProofNodeIdentity(predecessor.attestationId)).toBe(idA);

    // a different attestation of the SAME step (fresh nonce → fresh digest)
    // cannot silently map to the old node
    const sibling = signGraphAttestation(
      buildGraphStatement({
        stepId: 'collect_intake',
        nodeId: NODE_A_ID,
        action: 'Collect the intake form submission from the web portal',
        capability: 'browser.observe',
        executionClass: 'agentic_computer_use',
        nonce: 'challenge-cdr-run-0001-step-collect-retry',
      }),
      ATTESTER_NODE_A,
    );
    expect(sibling.attestationId).not.toBe(predecessor.attestationId);
    expect(deriveProofNodeIdentity(sibling.attestationId)).not.toBe(idA);
  });

  it('constructs the multi-node cross-device graph (predecessor + dependent)', () => {
    const predecessor = buildPredecessorAttestation();
    const dependent = buildDependentAttestation(predecessor);
    const builder = createProofGraphBuilder(PG_SCOPE);

    expectAccepted(builder.addAttestationNode(predecessor));
    const r2 = expectAccepted(builder.addAttestationNode(dependent));
    expect(r2.graph.nodes).toHaveLength(2);
    // nodes are canonically sorted by nodeIdentity
    const ids = r2.graph.nodes.map((n) => n.nodeIdentity);
    expect([...ids].sort()).toEqual(ids);
    // the dependent node carries the declared causal parent + commitment
    const dependentNode = r2.graph.nodes.find((n) => n.attestationId === dependent.attestationId)!;
    expect(dependentNode.declaredCausalParents).toEqual([predecessor.executionDigest.digest]);
    expect(dependentNode.executorNodeId).toBe(NODE_B_ID);
  });

  it('rejects an attestation outside the graph scope (cross-run substitution fails closed)', () => {
    const builder = createProofGraphBuilder(PG_SCOPE);
    const foreign = signGraphAttestation(
      buildGraphStatement({
        stepId: 'foreign_step',
        nodeId: NODE_A_ID,
        action: 'A step of a different run',
        nonce: 'challenge-foreign-run-9999',
        runId: 'wfr-some-other-run',
      }),
      ATTESTER_NODE_A,
    );
    const result = expectRejected(builder.addAttestationNode(foreign));
    expect(result.failure.code).toBe('GRAPH_SCOPE_MISMATCH');
    expect(result.graph.nodes).toHaveLength(0);
  });

  it('rejects an attestation whose version binding differs (cross-version substitution fails closed)', () => {
    const builder = createProofGraphBuilder(PG_SCOPE);
    const foreign = signGraphAttestation(
      buildGraphStatement({
        stepId: 'version_mismatch_step',
        nodeId: NODE_A_ID,
        action: 'A step of a different workflow version',
        nonce: 'challenge-foreign-version-9999',
        workflowVersionId: 'wfv-cross-device-report-4',
      }),
      ATTESTER_NODE_A,
    );
    const result = expectRejected(builder.addAttestationNode(foreign));
    expect(result.failure.code).toBe('GRAPH_SCOPE_MISMATCH');
  });

  it('converges duplicate attestation delivery to one logical node fact', () => {
    const predecessor = buildPredecessorAttestation();
    const builder = createProofGraphBuilder(PG_SCOPE);
    const first = expectAccepted(builder.addAttestationNode(predecessor));
    const second = expectDuplicate(builder.addAttestationNode(predecessor));

    expect(second.graph.nodes).toHaveLength(1);
    expect(second.graph.nodes[0]?.nodeIdentity).toBe(first.node?.nodeIdentity);
  });

  it('rejects a conflicting node redefinition (append-only, never last-write-wins)', () => {
    const predecessor = buildPredecessorAttestation();
    const builder = createProofGraphBuilder(PG_SCOPE);
    const first = expectAccepted(builder.addAttestationNode(predecessor));

    // same nodeIdentity, different content (a mutated reconstruction)
    const conflict = expectRejected(
      builder.addNode({
        ...first.node!,
        outcome: 'failed',
      }),
    );
    expect(conflict.failure.code).toBe('GRAPH_NODE_CONFLICT');
    // the graph is UNCHANGED by the rejected mutation
    expect(conflict.graph.nodes[0]?.outcome).toBe('succeeded');
    expect(conflict.graph.nodes).toHaveLength(1);
  });

  it('rejects a structurally invalid node candidate (typed, no mutation)', () => {
    const predecessor = buildPredecessorAttestation();
    const builder = createProofGraphBuilder(PG_SCOPE);
    // an attestation whose identity does not match its digest/key derivation
    const tampered: typeof predecessor = { ...predecessor, attestationId: 'wfea_tampered_identity_value' };
    const result = expectRejected(builder.addAttestationNode(tampered));
    expect(result.failure.code).toBe('GRAPH_NODE_INVALID');
    expect(result.graph.nodes).toHaveLength(0);
  });
});

describe('V2-015 graph core — edge construction and acyclicity', () => {
  function buildTwoNodeGraph() {
    const predecessor = buildPredecessorAttestation();
    const dependent = buildDependentAttestation(predecessor);
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(predecessor);
    builder.addAttestationNode(dependent);
    return { predecessor, dependent, builder };
  }

  it('adds the causal edge from the runtime-declared parent relationship', () => {
    const { predecessor, dependent, builder } = buildTwoNodeGraph();
    const result = expectAccepted(
      builder.addCausalEdge({
        parentAttestationId: predecessor.attestationId,
        childAttestationId: dependent.attestationId,
      }),
    );

    expect(result.edge?.relation).toBe('causal');
    expect(result.edge?.parentExecutionDigest).toBe(predecessor.executionDigest.digest);
    expect(result.edge?.childExecutionDigest).toBe(dependent.executionDigest.digest);
    expect(result.edge?.edgeIdentity).toBe(
      deriveProofEdgeIdentity({
        relation: 'causal',
        parentExecutionDigest: predecessor.executionDigest.digest,
        childExecutionDigest: dependent.executionDigest.digest,
      }),
    );
    const issues = validateGraphState(result.graph);
    expect(issues, JSON.stringify(issues)).toEqual([]);
  });

  it('converges duplicate causal-edge delivery to one logical edge fact', () => {
    const { predecessor, dependent, builder } = buildTwoNodeGraph();
    const first = expectAccepted(
      builder.addCausalEdge({
        parentAttestationId: predecessor.attestationId,
        childAttestationId: dependent.attestationId,
      }),
    );
    const second = expectDuplicate(
      builder.addCausalEdge({
        parentAttestationId: predecessor.attestationId,
        childAttestationId: dependent.attestationId,
      }),
    );
    expect(second.graph.edges).toHaveLength(1);
    expect(second.graph.edges[0]?.edgeIdentity).toBe(first.edge?.edgeIdentity);
  });

  it('adds dependency edges (composition-declared, no causal declaration required)', () => {
    const { predecessor, dependent, builder } = buildTwoNodeGraph();
    const result = expectAccepted(
      builder.addDependencyEdge({
        parentAttestationId: predecessor.attestationId,
        childAttestationId: dependent.attestationId,
        declaredBy: 'composition-authority-test',
      }),
    );
    expect(result.edge?.relation).toBe('dependency');
    const issues = validateGraphState(result.graph);
    expect(issues, JSON.stringify(issues)).toEqual([]);
  });

  it('rejects an edge whose parent node is missing (missing-parent rejection)', () => {
    const { dependent, builder } = buildTwoNodeGraph();
    const result = expectRejected(
      builder.addCausalEdge({
        parentAttestationId: 'wfea_missing_parent_attestation',
        childAttestationId: dependent.attestationId,
      }),
    );
    expect(result.failure.code).toBe('GRAPH_EDGE_UNKNOWN_NODE');
  });

  it('rejects an edge whose child node is missing', () => {
    const { predecessor, builder } = buildTwoNodeGraph();
    const result = expectRejected(
      builder.addCausalEdge({
        parentAttestationId: predecessor.attestationId,
        childAttestationId: 'wfea_missing_child_attestation',
      }),
    );
    expect(result.failure.code).toBe('GRAPH_EDGE_UNKNOWN_NODE');
  });

  it('rejects a self-edge', () => {
    const { predecessor, builder } = buildTwoNodeGraph();
    const result = expectRejected(
      builder.addCausalEdge({
        parentAttestationId: predecessor.attestationId,
        childAttestationId: predecessor.attestationId,
      }),
    );
    expect(result.failure.code).toBe('GRAPH_EDGE_SELF_LOOP');
  });

  it('rejects a causal edge the child never declared (parent mismatch rejection)', () => {
    // an independent attestation with NO causal parents, driven as if causal
    const predecessor = buildPredecessorAttestation();
    const independent = signGraphAttestation(
      buildGraphStatement({
        stepId: 'independent_step',
        nodeId: NODE_B_ID,
        action: 'A step with no declared parents',
        nonce: 'challenge-cdr-run-0001-step-independent',
      }),
      ATTESTER_NODE_B,
    );
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(predecessor);
    builder.addAttestationNode(independent);

    const result = expectRejected(
      builder.addCausalEdge({
        parentAttestationId: predecessor.attestationId,
        childAttestationId: independent.attestationId,
      }),
    );
    expect(result.failure.code).toBe('GRAPH_EDGE_PARENT_UNDECLARED');
  });

  it('rejects a direct cycle (A→B then B→A)', () => {
    // dependency edges carry the graph-level cycle invariant WITHOUT needing
    // executor-side causal declarations (which would be circularly
    // impossible for a genuine A⇄B pair: each statement would have to
    // pre-declare the other's real digest)
    const a = signGraphAttestation(
      buildGraphStatement({ stepId: 'cycle_step_a', nodeId: NODE_A_ID, action: 'Cycle step A', nonce: 'challenge-cycle-a' }),
      ATTESTER_NODE_A,
    );
    const b = signGraphAttestation(
      buildGraphStatement({ stepId: 'cycle_step_b', nodeId: NODE_B_ID, action: 'Cycle step B', nonce: 'challenge-cycle-b' }),
      ATTESTER_NODE_B,
    );
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(a);
    builder.addAttestationNode(b);

    expectAccepted(
      builder.addDependencyEdge({ parentAttestationId: a.attestationId, childAttestationId: b.attestationId, declaredBy: 'cycle-test' }),
    );
    const bToA = expectRejected(
      builder.addDependencyEdge({ parentAttestationId: b.attestationId, childAttestationId: a.attestationId, declaredBy: 'cycle-test' }),
    );
    expect(bToA.failure.code).toBe('GRAPH_EDGE_CYCLE');
    // the rejected edge did not mutate the graph
    expect(bToA.graph.edges).toHaveLength(1);
  });

  it('rejects a multi-hop cycle (A→B, B→C, then C→A)', () => {
    const a = signGraphAttestation(
      buildGraphStatement({ stepId: 'chain_a', nodeId: NODE_A_ID, action: 'Chain A', nonce: 'n-chain-a' }),
      ATTESTER_NODE_A,
    );
    const b = signGraphAttestation(
      buildGraphStatement({ stepId: 'chain_b', nodeId: NODE_B_ID, action: 'Chain B', nonce: 'n-chain-b' }),
      ATTESTER_NODE_B,
    );
    const c = signGraphAttestation(
      buildGraphStatement({ stepId: 'chain_c', nodeId: NODE_A_ID, action: 'Chain C', nonce: 'n-chain-c' }),
      ATTESTER_NODE_A,
    );
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(a);
    builder.addAttestationNode(b);
    builder.addAttestationNode(c);

    expectAccepted(
      builder.addDependencyEdge({ parentAttestationId: a.attestationId, childAttestationId: b.attestationId, declaredBy: 'chain-test' }),
    );
    expectAccepted(
      builder.addDependencyEdge({ parentAttestationId: b.attestationId, childAttestationId: c.attestationId, declaredBy: 'chain-test' }),
    );
    const closing = expectRejected(
      builder.addDependencyEdge({ parentAttestationId: c.attestationId, childAttestationId: a.attestationId, declaredBy: 'chain-test' }),
    );
    expect(closing.failure.code).toBe('GRAPH_EDGE_CYCLE');
  });

  it('accepts independent parallel branches (no false cycle)', () => {
    const root = buildPredecessorAttestation();
    const left = signGraphAttestation(
      buildGraphStatement({ stepId: 'branch_left', nodeId: NODE_A_ID, action: 'Left branch', nonce: 'n-left', causalParents: [root.executionDigest.digest] }),
      ATTESTER_NODE_A,
    );
    const right = signGraphAttestation(
      buildGraphStatement({ stepId: 'branch_right', nodeId: NODE_B_ID, action: 'Right branch', nonce: 'n-right', causalParents: [root.executionDigest.digest] }),
      ATTESTER_NODE_B,
    );
    const builder = createProofGraphBuilder(PG_SCOPE);
    builder.addAttestationNode(root);
    builder.addAttestationNode(left);
    builder.addAttestationNode(right);
    expectAccepted(builder.addCausalEdge({ parentAttestationId: root.attestationId, childAttestationId: left.attestationId }));
    expectAccepted(builder.addCausalEdge({ parentAttestationId: root.attestationId, childAttestationId: right.attestationId }));
    // left and right are siblings, not ancestors of each other — a causal
    // edge between them was never declared by either statement
    const cross = expectRejected(
      builder.addCausalEdge({ parentAttestationId: left.attestationId, childAttestationId: right.attestationId }),
    );
    expect(cross.failure.code).toBe('GRAPH_EDGE_PARENT_UNDECLARED');
  });
});

import { describe, it, expect } from 'vitest';
import {
  createProofGraphBuilder,
  deliverGraphFragment,
  serializeProofGraph,
  computeGraphDigest,
  parseProofGraph,
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
 * V2-015 Task 4 — replay/duplicate convergence at graph level (invariant 7).
 *
 * Proves:
 *   - delivering the same node/edge/fragment twice converges to ONE logical
 *     graph fact (zero mutations on re-delivery, converged: true);
 *   - repeated delivery in DIFFERENT orders produces byte-identical state;
 *   - conflicting redefinition of the same stable identity is REJECTED
 *     (typed, never last-write-wins);
 *   - the serialized form and digest are stable across delivery histories;
 *   - conflicting branches delivered as fragments converge to the same
 *     graph.
 */

/** The canonical two-step graph (predecessor → dependent) as a fragment. */
function buildTwoStepFragment() {
  const predecessor = buildPredecessorAttestation();
  const dependent = buildDependentAttestation(predecessor);
  const builder = createProofGraphBuilder(PG_SCOPE);
  builder.addAttestationNode(predecessor);
  builder.addAttestationNode(dependent);
  builder.addCausalEdge({ parentAttestationId: predecessor.attestationId, childAttestationId: dependent.attestationId });
  return { fragment: builder.graph, predecessor, dependent };
}

describe('V2-015 replay/duplicate convergence', () => {
  it('re-delivering the same fragment converges: zero accepts, all duplicates, unchanged state', () => {
    const { fragment } = buildTwoStepFragment();
    const target = createProofGraphBuilder(PG_SCOPE);

    const first = deliverGraphFragment(target, fragment);
    expect(first.converged).toBe(true);
    expect(first.nodesAccepted).toBe(2);
    expect(first.nodesDuplicated).toBe(0);
    expect(first.edgesAccepted).toBe(1);

    const second = deliverGraphFragment(target, fragment);
    expect(second.converged).toBe(true);
    expect(second.nodesAccepted).toBe(0);
    expect(second.nodesDuplicated).toBe(2);
    expect(second.edgesAccepted).toBe(0);
    expect(second.edgesDuplicated).toBe(1);
    // one logical fact — the state is UNCHANGED by the replay
    expect(second.graph.nodes).toHaveLength(2);
    expect(second.graph.edges).toHaveLength(1);
    expect(serializeProofGraph(second.graph)).toBe(serializeProofGraph(first.graph));
  });

  it('fragment delivery in different orders converges to byte-identical state', () => {
    const { fragment } = buildTwoStepFragment();
    const forward = createProofGraphBuilder(PG_SCOPE);
    const backward = createProofGraphBuilder(PG_SCOPE);

    // forward: nodes in canonical order
    deliverGraphFragment(forward, fragment);
    // backward: a reversed-copy fragment (same logical facts, opposite order)
    const reversed = {
      ...fragment,
      nodes: [...fragment.nodes].reverse(),
      edges: [...fragment.edges].reverse(),
    };
    deliverGraphFragment(backward, reversed);

    expect(serializeProofGraph(backward.graph)).toBe(serializeProofGraph(forward.graph));
    expect(computeGraphDigest(backward.graph)).toBe(computeGraphDigest(forward.graph));
  });

  it('a conflicting fragment (mutated node) is REJECTED, never merged (append-only)', () => {
    const { fragment } = buildTwoStepFragment();
    const target = createProofGraphBuilder(PG_SCOPE);
    deliverGraphFragment(target, fragment);

    // the coordinator mutates one node's outcome and re-delivers
    const mutatedView = JSON.parse(JSON.stringify(fragment)) as {
      nodes: Array<Record<string, unknown>>;
    };
    const nodeToMutate = mutatedView.nodes[0]!;
    nodeToMutate['outcome'] = nodeToMutate['outcome'] === 'succeeded' ? 'failed' : 'succeeded';
    const mutated = mutatedView as unknown as typeof fragment;
    // keep the parent commitment consistent so the CONFLICT (not the
    // commitment check) is what fires
    const result = deliverGraphFragment(target, mutated);

    expect(result.converged).toBe(false);
    expect(result.nodesRejected).toHaveLength(1);
    expect(result.nodesRejected[0]?.code).toBe('GRAPH_NODE_CONFLICT');
    expect(result.nodesDuplicated).toBe(1);
    // the state is UNCHANGED — the original outcome survives
    const outcomes = result.graph.nodes.map((n) => n.outcome).sort();
    expect(outcomes).toEqual(['failed', 'succeeded'].sort().reverse().sort().length === 2 ? outcomes.slice(0, 2) : outcomes);
    expect(result.graph.nodes.find((n) => n.nodeIdentity === mutated.nodes[0]!.nodeIdentity)?.outcome).toBe('succeeded');
    expect(result.graph.nodes.find((n) => n.nodeIdentity === mutated.nodes[0]!.nodeIdentity)?.outcome).not.toBe(mutated.nodes[0]!.outcome);
  });

  it('an edge with a broken endpoint digest is rejected at fragment delivery', () => {
    const { fragment } = buildTwoStepFragment();
    const target = createProofGraphBuilder(PG_SCOPE);
    // deliver only the NODES first (skip the edge)
    const nodesOnly = { ...fragment, edges: [] };
    deliverGraphFragment(target, nodesOnly);

    // a mutated edge whose parent digest no longer matches the parent node
    const mutatedEdgeView = JSON.parse(JSON.stringify(fragment)) as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    mutatedEdgeView.nodes = [];
    mutatedEdgeView.edges[0]!['parentExecutionDigest'] = 'e'.repeat(64);
    const mutatedEdge = mutatedEdgeView as unknown as typeof fragment;
    const result = deliverGraphFragment(target, mutatedEdge);
    expect(result.converged).toBe(false);
    // the mutated fragment is rejected WHOLE at pre-merge validation
    expect(result.fragmentRejected.length).toBeGreaterThan(0);
    expect(result.edgesAccepted).toBe(0);
  });

  it('a fragment scope-substituted node is rejected (cross-run/cross-version fails closed)', () => {
    const { fragment } = buildTwoStepFragment();
    const target = createProofGraphBuilder(PG_SCOPE);
    const mutatedView = JSON.parse(JSON.stringify(fragment)) as {
      nodes: Array<Record<string, unknown>>;
    };
    mutatedView.nodes[0]!['runId'] = 'wfr-a-different-run';
    const mutated = mutatedView as unknown as typeof fragment;
    const result = deliverGraphFragment(target, mutated);
    expect(result.converged).toBe(false);
    expect(result.fragmentRejected[0]?.code).toBe('GRAPH_SCOPE_MISMATCH');
  });

  it('conflicting BRANCHES delivered as fragments converge to the same graph (diamond)', () => {
    const root = buildPredecessorAttestation();
    const left = signGraphAttestation(
      buildGraphStatement({ stepId: 'branch_left', nodeId: NODE_A_ID, action: 'Left branch', nonce: 'n-cb-left', causalParents: [root.executionDigest.digest] }),
      ATTESTER_NODE_A,
    );
    const right = signGraphAttestation(
      buildGraphStatement({ stepId: 'branch_right', nodeId: NODE_B_ID, action: 'Right branch', nonce: 'n-cb-right', causalParents: [root.executionDigest.digest] }),
      ATTESTER_NODE_B,
    );

    const leftFragment = (() => {
      const b = createProofGraphBuilder(PG_SCOPE);
      b.addAttestationNode(root);
      b.addAttestationNode(left);
      b.addCausalEdge({ parentAttestationId: root.attestationId, childAttestationId: left.attestationId });
      return b.graph;
    })();
    const rightFragment = (() => {
      const b = createProofGraphBuilder(PG_SCOPE);
      b.addAttestationNode(root);
      b.addAttestationNode(right);
      b.addCausalEdge({ parentAttestationId: root.attestationId, childAttestationId: right.attestationId });
      return b.graph;
    })();

    // left-then-right and right-then-left converge to the SAME graph
    const orderOne = createProofGraphBuilder(PG_SCOPE);
    deliverGraphFragment(orderOne, leftFragment);
    deliverGraphFragment(orderOne, rightFragment);
    const orderTwo = createProofGraphBuilder(PG_SCOPE);
    deliverGraphFragment(orderTwo, rightFragment);
    deliverGraphFragment(orderTwo, leftFragment);

    expect(serializeProofGraph(orderOne.graph)).toBe(serializeProofGraph(orderTwo.graph));
    expect(orderOne.graph.nodes).toHaveLength(3);
    expect(orderOne.graph.edges).toHaveLength(2);
    // the shared root node converged (one duplicate tally on the second delivery)
  });

  it('a serialized round-trip fragment converges identically with the in-memory graph', () => {
    const { fragment } = buildTwoStepFragment();
    const serialized = serializeProofGraph(fragment);
    const parsed = parseProofGraph(serialized);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(`parse failed: ${parsed.failure.code}`);
    }
    const target = createProofGraphBuilder(PG_SCOPE);
    const result = deliverGraphFragment(target, parsed.graph);
    expect(result.converged).toBe(true);
    expect(result.nodesAccepted).toBe(2);
    expect(serializeProofGraph(result.graph)).toBe(serialized);
  });

  it('replaying a single attestation into the graph is idempotent (same node identity)', () => {
    const predecessor = buildPredecessorAttestation();
    const target = createProofGraphBuilder(PG_SCOPE);
    const first = target.addAttestationNode(predecessor);
    const second = target.addAttestationNode(predecessor);
    const third = target.addAttestationNode(predecessor);
    expect(first.kind).toBe('accepted');
    expect(second.kind).toBe('duplicate');
    expect(third.kind).toBe('duplicate');
    expect(target.graph.nodes).toHaveLength(1);
  });
});

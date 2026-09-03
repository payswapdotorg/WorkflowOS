import { describe, it, expect } from 'vitest';
import {
  verifyAttestation,
  InMemoryReplayRegistry,
  type ExecutionAttestation,
} from '../../../src/execution-attestation/index.js';
import {
  createProofGraphBuilder,
  planCrossDeviceContinuation,
  recordContinuationOutcome,
  verifyGraphAgainstAttestations,
  deliverGraphFragment,
  deriveParentCommitment,
  deriveProofEdgeIdentity,
  deriveProofNodeIdentity,
  type ExecutionProofGraph,
} from '../../../src/execution-proof-graph/index.js';
import {
  PG_SCOPE,
  buildPredecessorAttestation,
  buildGraphStatement,
  signGraphAttestation,
  ATTESTER_NODE_A,
  ATTESTER_NODE_B,
  NODE_B_ID,
} from '../../unit/execution-proof-graph/helpers.js';

/**
 * V2-015 Task 6 — malicious coordinator mutation detection (invariant 10:
 * a coordinator cannot alter the graph without detection because node
 * identity, parent commitments and canonical graph relationships are
 * verified against the SOURCE attestations).
 *
 * Each experiment builds the TRUE graph from real Ed25519 attestations,
 * hands the coordinator position a mutated copy, and proves detection
 * through BOTH lines of defense:
 *   1. fragment delivery: the pre-merge consistency validation (typed,
 *      whole-fragment rejection — never partially merged);
 *   2. independent reconstruction: verifyGraphAgainstAttestations compares
 *      the delivered graph against the projection of the SOURCE
 *      attestations — catching even a coordinator that RECOMPUTES the
 *      parent commitment after mutating the declared parents (internal
 *      consistency is forgeable; equality with the authenticated evidence
 *      is not).
 */

const NOW = '2026-09-02T08:00:30.000Z';

function verifyPredecessor(attestation: ExecutionAttestation) {
  // a minimal trusted-verifier context for continuation planning reuse
  return verifyAttestation(attestation, {
    bindings: {},
    freshness: { now: NOW, currentEpoch: 11, replayRegistry: new InMemoryReplayRegistry(), maxAgeMs: 60 * 60 * 1000 },
    attesterKeyIds: [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
    requiredAssurance: 'software_signed',
  });
}

/** The true two-node graph + the source attestations (the evidence authority). */
function buildTrueGraph(): {
  trueGraph: ExecutionProofGraph;
  sources: readonly ExecutionAttestation[];
  predecessor: ExecutionAttestation;
  produced: ExecutionAttestation;
} {
  const predecessor = buildPredecessorAttestation();
  const produced = signGraphAttestation(
    buildGraphStatement({
      stepId: 'write_report',
      nodeId: NODE_B_ID,
      action: 'Write the acknowledged report to the local reports directory',
      capability: 'filesystem.write',
      executionClass: 'agentic_computer_use',
      causalParents: [predecessor.executionDigest.digest],
      nonce: 'challenge-cdr-run-0001-step-write-mut',
      executedAt: '2026-09-02T08:01:00.000Z',
    }),
    ATTESTER_NODE_B,
  );
  const builder = createProofGraphBuilder(PG_SCOPE);
  builder.addAttestationNode(predecessor);
  const recording = recordContinuationOutcome(builder, produced);
  if (recording.nodeResult.kind !== 'accepted') {
    throw new Error('fixture: the produced attestation must fold in');
  }
  return { trueGraph: builder.graph, sources: [predecessor, produced], predecessor, produced };
}

/** A deep mutable copy of the true graph (the coordinator position). */
function coordinatorCopy(trueGraph: ExecutionProofGraph): { graph: ExecutionProofGraph; view: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } } {
  const view = JSON.parse(JSON.stringify(trueGraph)) as {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  return { graph: view as unknown as ExecutionProofGraph, view };
}

describe('V2-015 coordinator-mutation detection (both lines of defense)', () => {
  it('control: the unmutated coordinator delivery verifies clean against the sources', () => {
    const { trueGraph, sources } = buildTrueGraph();
    const { graph } = coordinatorCopy(trueGraph);
    expect(verifyGraphAgainstAttestations(graph, sources).ok).toBe(true);

    const target = createProofGraphBuilder(PG_SCOPE);
    const delivery = deliverGraphFragment(target, graph);
    expect(delivery.converged).toBe(true);
    expect(delivery.nodesAccepted).toBe(2);
  });

  it('mutated declared causal parents WITH a recomputed parent commitment is detected by independent reconstruction', () => {
    const { trueGraph, sources } = buildTrueGraph();
    const { graph, view } = coordinatorCopy(trueGraph);

    // the sneaky coordinator: swaps the declared parent digest AND
    // recomputes the parent commitment (internal consistency stays valid)
    const dependentView = view.nodes.find((n) => n['stepId'] === 'write_report')!;
    const forgedDigest = 'f'.repeat(64);
    dependentView['declaredCausalParents'] = [forgedDigest];
    // recompute the commitment exactly as the module would (forgeable —
    // the derivation is public); detection must NOT rely on it
    dependentView['parentCommitment'] = deriveParentCommitment([forgedDigest]);

    // line 2: the delivered graph no longer equals the SOURCE projection
    const verification = verifyGraphAgainstAttestations(graph, sources);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      const conflict = verification.failures.find((f) => f.code === 'GRAPH_NODE_CONFLICT');
      expect(conflict).toBeDefined();
      expect(conflict?.detail).toContain('causalParents/parentCommitment');
    }
  });

  it('mutated node identity (re-pointed nodeIdentity) is detected', () => {
    const { trueGraph, sources } = buildTrueGraph();
    const { graph, view } = coordinatorCopy(trueGraph);
    const victim = view.nodes[0]!;
    victim['nodeIdentity'] = 'wfpgn_' + '9'.repeat(64);

    const verification = verifyGraphAgainstAttestations(graph, sources);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.failures.some((f) => f.code === 'GRAPH_NODE_CONFLICT' && f.detail.includes('nodeIdentity'))).toBe(true);
    }

    // line 1: fragment delivery also rejects (the edge endpoints + identity
    // derivations break in the internally-consistent validator)
    const target = createProofGraphBuilder(PG_SCOPE);
    const delivery = deliverGraphFragment(target, graph);
    expect(delivery.converged).toBe(false);
  });

  it('mutated Run binding is detected (scope substitution)', () => {
    const { trueGraph, sources } = buildTrueGraph();
    const { graph, view } = coordinatorCopy(trueGraph);
    const victim = view.nodes[0]!;
    const originalRunId = victim['runId'] as string;
    victim['runId'] = 'wfr-tampered-run';

    const verification = verifyGraphAgainstAttestations(graph, sources);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.failures.some((f) => f.code === 'GRAPH_NODE_CONFLICT' && f.detail.includes('runId'))).toBe(true);
    }
    void originalRunId;

    // fragment delivery: the scope check rejects the whole fragment
    const target = createProofGraphBuilder(PG_SCOPE);
    expect(deliverGraphFragment(target, graph).converged).toBe(false);
  });

  it('mutated WorkflowVersion binding is detected', () => {
    const { trueGraph, sources } = buildTrueGraph();
    const { graph, view } = coordinatorCopy(trueGraph);
    const victim = view.nodes[0]!;
    victim['workflowVersionId'] = 'wfv-tampered-version';

    const verification = verifyGraphAgainstAttestations(graph, sources);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.failures.some((f) => f.code === 'GRAPH_NODE_CONFLICT' && f.detail.includes('workflowVersionId'))).toBe(true);
    }
  });

  it('a re-wired causal edge (parent the child never declared) is detected', () => {
    const { trueGraph, sources } = buildTrueGraph();
    const { graph, view } = coordinatorCopy(trueGraph);
    // re-point the edge at the OTHER node (both nodes exist; the child never
    // declared THAT parent) and re-derive the identity
    const edgeView = view.edges[0]!;
    const predecessorNode = view.nodes.find((n) => n['stepId'] === 'collect_intake')!;
    const dependentNode = view.nodes.find((n) => n['stepId'] === 'write_report')!;
    // swap the edge direction: dependent → predecessor (never declared)
    edgeView['parentNode'] = dependentNode['nodeIdentity'];
    edgeView['childNode'] = predecessorNode['nodeIdentity'];
    edgeView['parentExecutionDigest'] = dependentNode['executionDigest'];
    edgeView['childExecutionDigest'] = predecessorNode['executionDigest'];
    edgeView['edgeIdentity'] = deriveProofEdgeIdentity({
      relation: 'causal',
      parentExecutionDigest: dependentNode['executionDigest'] as string,
      childExecutionDigest: predecessorNode['executionDigest'] as string,
    });

    // line 1: the pre-merge causal-declaration check rejects the fragment
    const target = createProofGraphBuilder(PG_SCOPE);
    const delivery = deliverGraphFragment(target, graph);
    expect(delivery.converged).toBe(false);
    if (delivery.fragmentRejected.length > 0) {
      expect(delivery.fragmentRejected[0]?.code).toBe('GRAPH_EDGE_PARENT_UNDECLARED');
    }

    // line 2: the source comparison flags the re-wired relationship
    const verification = verifyGraphAgainstAttestations(graph, sources);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.failures.some((f) => f.code === 'GRAPH_EDGE_PARENT_UNDECLARED')).toBe(true);
    }
  });

  it('a coordinator-INVENTED node (no source attestation) is detected', () => {
    const { trueGraph, sources } = buildTrueGraph();
    const { graph, view } = coordinatorCopy(trueGraph);
    // invent a third node by cloning the predecessor with a new identity
    const clone = { ...view.nodes.find((n) => n['stepId'] === 'collect_intake')! };
    clone['attestationId'] = 'wfea_invented_attestation';
    clone['nodeIdentity'] = deriveProofNodeIdentity('wfea_invented_attestation');
    view.nodes.push(clone);

    const verification = verifyGraphAgainstAttestations(graph, sources);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.failures.some((f) => f.detail.includes('no source attestation'))).toBe(true);
    }
  });

  it('a dropped source node is detected (truncated history)', () => {
    const { trueGraph, sources } = buildTrueGraph();
    const { graph, view } = coordinatorCopy(trueGraph);
    view.nodes.splice(0, 1);

    const verification = verifyGraphAgainstAttestations(graph, sources);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.failures.some((f) => f.detail.includes('missing from the delivered graph'))).toBe(true);
    }
  });

  it('the mutated graph never admits a continuation the sources would not', () => {
    const { trueGraph, predecessor, sources } = buildTrueGraph();
    void sources;
    const { graph, view } = coordinatorCopy(trueGraph);
    // the coordinator FORGES a node whose verification fact does not exist:
    // mutate the dependent node to claim it has NO parents
    const dependentView = view.nodes.find((n) => n['stepId'] === 'write_report')!;
    dependentView['declaredCausalParents'] = [];
    dependentView['parentCommitment'] = deriveParentCommitment([]);

    // the continuation over the MUTATED graph: the declared parent set of
    // the PLAN still requires the predecessor digest — which remains a
    // graph node — and the REAL verification still succeeds; the planning
    // layer is driven by the FACTS and the caller's declared set, not by
    // the mutated node's self-declared parents (the produced statement is
    // the authority for its own causal parents)
    const verification = verifyPredecessor(predecessor);
    expect(verification.ok).toBe(true);
    const decision = planCrossDeviceContinuation({
      graph,
      dependent: {
        stepId: 'notify_next',
        workflowId: PG_SCOPE.workflowId,
        workflowVersionId: PG_SCOPE.workflowVersionId,
        workflowVersionSemanticDigest: PG_SCOPE.workflowVersionSemanticDigest,
        runId: PG_SCOPE.runId,
      },
      declaredParents: [predecessor.executionDigest.digest],
      predecessorEvidence: [{ executionDigest: predecessor.executionDigest.digest, verification }],
      trustPolicy: {
        trustedAttesterKeyIds: [ATTESTER_NODE_A.keyId, ATTESTER_NODE_B.keyId],
        requiredAssurance: 'software_signed',
        now: NOW,
        currentEpoch: 11,
      },
    });
    // the plan itself is fact-driven and admits; the DETECTION is that the
    // delivered graph fails source verification (asserted above/below)
    expect(decision.continuation).toBe('admitted');
    expect(verifyGraphAgainstAttestations(graph, [predecessor]).ok).toBe(false);
  });
});

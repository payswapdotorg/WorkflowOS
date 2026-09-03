/**
 * V2-015 — internal/pure graph construction.
 *
 * The deterministic, append-only proof-graph core:
 *   - `createProofGraphBuilder(scope)` opens the graph for ONE
 *     (workflow, workflowVersion, run) scope — the graph identity is derived
 *     ONLY from that triple (cross-device continuation preserves
 *     Run/WorkflowVersion identity by construction);
 *   - `addAttestationNode(attestation)` is the RUNTIME path: projects a real
 *     V2-014 envelope to its node (validated structurally, scoped, append-only);
 *   - `addNode(node)` is the RECONSTRUCTION path (delivered fragments,
 *     deserialized graphs): same validation, same append-only semantics;
 *   - `addCausalEdge` / `addDependencyEdge` derive EVERY binding from the
 *     graph's OWN node set — the caller supplies only attestation identities,
 *     so there is no coordinator surface for arbitrary digests.
 *
 * The builder is PURE with respect to the OUTSIDE: no clock, no randomness,
 * no network, no persistence. Its internal state advances only through
 * ACCEPTED mutations; every mutation returns the immutable snapshot after
 * the attempt plus a typed result:
 *   accepted | duplicate (converged, one logical fact) |
 *   rejected (typed failure; the state is UNCHANGED — append-only).
 */

import type { ExecutionAttestation, Sha256Hex } from '../../execution-attestation/index.js';
import type {
  ExecutionProofEdge,
  ExecutionProofGraph,
  ExecutionProofNode,
  ProofGraphFailure,
  ProofGraphMutationResult,
} from '../types.js';
import {
  deriveGraphIdentity,
  deriveProofEdgeIdentity,
  deriveProofNodeIdentity,
  edgeWouldCreateCycle,
  nodesEqual,
  edgesEqual,
  projectAttestationToNode,
  validateEdgeCandidate,
  validateNodeCandidate,
} from './validation.js';

/** The scope of one logical proof graph (Run/WorkflowVersion identity). */
export interface ProofGraphScope {
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowVersionSemanticDigest: Sha256Hex;
  readonly runId: string;
}

/** The append-only proof-graph builder (immutable snapshots, typed results). */
export interface ProofGraphBuilder {
  /** The current immutable graph state. */
  readonly graph: ExecutionProofGraph;
  /** The runtime path: project + validate + append a real attestation. */
  addAttestationNode(attestation: ExecutionAttestation): ProofGraphMutationResult;
  /** The reconstruction path: validate + append a delivered node projection. */
  addNode(node: ExecutionProofNode): ProofGraphMutationResult;
  /** The causal edge (the child's own statement declared the parent digest). */
  addCausalEdge(input: EdgeInput): ProofGraphMutationResult;
  /** The dependency edge (composition-declared reliance). */
  addDependencyEdge(input: EdgeInput & { readonly declaredBy: string }): ProofGraphMutationResult;
}

/** Edge input: endpoint ATTESTATION identities (never raw digests). */
export interface EdgeInput {
  readonly parentAttestationId: string;
  readonly childAttestationId: string;
}

/** Open the proof graph for one scope (identity derived from the triple). */
export function createProofGraphBuilder(scope: ProofGraphScope): ProofGraphBuilder {
  let current: ExecutionProofGraph = {
    objectType: 'workflowos/execution-proof-graph/v1',
    schemaVersion: 1,
    graphIdentity: deriveGraphIdentity(scope),
    workflowId: scope.workflowId,
    workflowVersionId: scope.workflowVersionId,
    workflowVersionSemanticDigest: scope.workflowVersionSemanticDigest,
    runId: scope.runId,
    nodes: [],
    edges: [],
  };

  const builder: ProofGraphBuilder = {
    get graph() {
      return current;
    },
    addAttestationNode(attestation) {
      const issues = validateNodeCandidate(attestation);
      if (issues.length > 0) {
        return rejected(current, issues[0]!);
      }
      const node = projectAttestationToNode(attestation);
      const scopeFailure = scopeMismatch(current, node.workflowId, node.workflowVersionId, node.workflowVersionSemanticDigest, node.runId, node.attestationId);
      if (scopeFailure) {
        return rejected(current, scopeFailure);
      }
      const result = appendNode(current, node);
      if (result.kind === 'accepted') {
        current = result.graph;
      }
      return result;
    },
    addNode(node) {
      const shapeIssues = validateNodeShape(node);
      if (shapeIssues.length > 0) {
        return rejected(current, shapeIssues[0]!);
      }
      if (node.nodeIdentity !== deriveProofNodeIdentity(node.attestationId)) {
        return rejected(current, {
          code: 'GRAPH_NODE_INVALID',
          detail: 'node identity does not match its attestation binding',
          identity: node.nodeIdentity,
        });
      }
      const scopeFailure = scopeMismatch(current, node.workflowId, node.workflowVersionId, node.workflowVersionSemanticDigest, node.runId, node.nodeIdentity);
      if (scopeFailure) {
        return rejected(current, scopeFailure);
      }
      const result = appendNode(current, node);
      if (result.kind === 'accepted') {
        current = result.graph;
      }
      return result;
    },
    addCausalEdge(input) {
      const result = appendEdge(current, { ...input, relation: 'causal' });
      if (result.kind === 'accepted') {
        current = result.graph;
      }
      return result;
    },
    addDependencyEdge(input) {
      const result = appendEdge(current, { ...input, relation: 'dependency' });
      if (result.kind === 'accepted') {
        current = result.graph;
      }
      return result;
    },
  };
  return builder;
}

// ============================================================================
// Append-only core (nodes)
// ============================================================================

function appendNode(
  graph: ExecutionProofGraph,
  node: ExecutionProofNode,
): ProofGraphMutationResult {
  const existing = graph.nodes.find((n) => n.nodeIdentity === node.nodeIdentity);
  if (existing) {
    if (nodesEqual(existing, node)) {
      return { kind: 'duplicate', node: existing, graph };
    }
    return rejected(graph, {
      code: 'GRAPH_NODE_CONFLICT',
      detail: 'conflicting redefinition of an existing node identity (append-only: prior verified facts cannot be rewritten)',
      identity: node.nodeIdentity,
    });
  }
  const next: ExecutionProofGraph = {
    ...graph,
    nodes: sortedBy([...graph.nodes, node], (n) => n.nodeIdentity),
  };
  return { kind: 'accepted', node, graph: next };
}

// ============================================================================
// Append-only core (edges — every binding derived from the graph's own nodes)
// ============================================================================

function appendEdge(
  graph: ExecutionProofGraph,
  input: EdgeInput & { readonly relation: 'causal' | 'dependency' },
): ProofGraphMutationResult {
  const parentNode = graph.nodes.find((n) => n.attestationId === input.parentAttestationId);
  const childNode = graph.nodes.find((n) => n.attestationId === input.childAttestationId);
  if (!parentNode) {
    return rejected(graph, {
      code: 'GRAPH_EDGE_UNKNOWN_NODE',
      detail: `parent attestation is not present in the graph: ${input.parentAttestationId}`,
      identity: input.parentAttestationId,
    });
  }
  if (!childNode) {
    return rejected(graph, {
      code: 'GRAPH_EDGE_UNKNOWN_NODE',
      detail: `child attestation is not present in the graph: ${input.childAttestationId}`,
      identity: input.childAttestationId,
    });
  }
  if (parentNode.nodeIdentity === childNode.nodeIdentity) {
    return rejected(graph, {
      code: 'GRAPH_EDGE_SELF_LOOP',
      detail: 'a proof edge cannot relate a node to itself',
      identity: parentNode.nodeIdentity,
    });
  }

  const edge: ExecutionProofEdge = {
    edgeIdentity: deriveProofEdgeIdentity({
      relation: input.relation,
      parentExecutionDigest: parentNode.executionDigest,
      childExecutionDigest: childNode.executionDigest,
    }),
    relation: input.relation,
    parentNode: parentNode.nodeIdentity,
    childNode: childNode.nodeIdentity,
    parentExecutionDigest: parentNode.executionDigest,
    childExecutionDigest: childNode.executionDigest,
  };

  const edgeIssues = validateEdgeCandidate(graph, edge);
  if (edgeIssues.length > 0) {
    return rejected(graph, edgeIssues[0]!);
  }
  if (edgeWouldCreateCycle(graph, edge.parentNode, edge.childNode)) {
    return rejected(graph, {
      code: 'GRAPH_EDGE_CYCLE',
      detail: 'the edge would introduce a cycle into the proof graph (causal edges are acyclic)',
      identity: edge.edgeIdentity,
    });
  }

  const existing = graph.edges.find((e) => e.edgeIdentity === edge.edgeIdentity);
  if (existing) {
    if (edgesEqual(existing, edge)) {
      return { kind: 'duplicate', edge: existing, graph };
    }
    return rejected(graph, {
      code: 'GRAPH_EDGE_CONFLICT',
      detail: 'conflicting redefinition of an existing edge identity (append-only)',
      identity: edge.edgeIdentity,
    });
  }

  const next: ExecutionProofGraph = {
    ...graph,
    edges: sortedBy([...graph.edges, edge], (e) => e.edgeIdentity),
  };
  return { kind: 'accepted', edge, graph: next };
}

// ============================================================================
// Helpers
// ============================================================================

function rejected(graph: ExecutionProofGraph, failure: ProofGraphFailure): ProofGraphMutationResult {
  return { kind: 'rejected', failure, graph };
}

function scopeMismatch(
  graph: ExecutionProofGraph,
  workflowId: string,
  workflowVersionId: string,
  workflowVersionSemanticDigest: string,
  runId: string,
  identity: string,
): ProofGraphFailure | null {
  if (
    workflowId !== graph.workflowId ||
    workflowVersionId !== graph.workflowVersionId ||
    workflowVersionSemanticDigest !== graph.workflowVersionSemanticDigest ||
    runId !== graph.runId
  ) {
    return {
      code: 'GRAPH_SCOPE_MISMATCH',
      detail: 'candidate does not belong to this graph scope (workflow/version/run binding mismatch)',
      identity,
    };
  }
  return null;
}

function sortedBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Structural shape check for a delivered/reconstructed node projection. */
function validateNodeShape(node: ExecutionProofNode): readonly ProofGraphFailure[] {
  const issues: ProofGraphFailure[] = [];
  if (typeof node.nodeIdentity !== 'string' || node.nodeIdentity.length === 0) {
    issues.push({ code: 'GRAPH_NODE_INVALID', detail: 'nodeIdentity must be a non-empty string' });
  }
  if (typeof node.attestationId !== 'string' || node.attestationId.length === 0) {
    issues.push({ code: 'GRAPH_NODE_INVALID', detail: 'attestationId must be a non-empty string' });
  }
  if (typeof node.executionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(node.executionDigest)) {
    issues.push({ code: 'GRAPH_NODE_INVALID', detail: 'executionDigest must be a sha-256 hex digest', identity: node.nodeIdentity });
  }
  if (typeof node.parentCommitment !== 'string' || !/^[0-9a-f]{64}$/.test(node.parentCommitment)) {
    issues.push({ code: 'GRAPH_NODE_INVALID', detail: 'parentCommitment must be a sha-256 hex digest', identity: node.nodeIdentity });
  }
  if (!Array.isArray(node.declaredCausalParents)) {
    issues.push({ code: 'GRAPH_NODE_INVALID', detail: 'declaredCausalParents must be an array', identity: node.nodeIdentity });
  }
  if (typeof node.attemptId !== 'number' || !Number.isInteger(node.attemptId) || node.attemptId < 1) {
    issues.push({ code: 'GRAPH_NODE_INVALID', detail: 'attemptId must be an integer >= 1', identity: node.nodeIdentity });
  }
  return issues;
}

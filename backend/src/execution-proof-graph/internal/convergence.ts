/**
 * V2-015 — internal/multi-parent satisfaction and replay convergence.
 *
 * Deterministic multi-parent dependency satisfaction and idempotent
 * duplicate/replay convergence at GRAPH level (invariants 6/7):
 *
 *   - `evaluateGraphAdmission` grounds the admission predicate in the GRAPH
 *     STATE: every declared parent digest must correspond to a node present
 *     in the graph (evidence alone is not enough — the causal history must
 *     be reconstructable), then the verification-derived admission predicate
 *     runs over the supplied facts;
 *   - `deliverGraphFragment` merges a delivered graph fragment into a
 *     builder idempotently: nodes and edges are processed in canonical
 *     order, duplicate delivery converges (zero mutations), conflicting
 *     redefinition is a typed rejection, and the result tallies are
 *     deterministic;
 *   - the module is PURE: no clock, no randomness, no persistence; the
 *     caller injects every verification fact and the graph state.
 */

import type { PredecessorEvidence, ProofAdmissionInput, ProofAdmissionResult, ExecutionProofGraph, ProofGraphFailure } from '../types.js';
import { evaluateProofAdmission } from './admission.js';
import { validateGraphConsistency } from './validation.js';
import type { ProofGraphBuilder } from './graph.js';

// ============================================================================
// Graph-grounded multi-parent admission
// ============================================================================

/** The graph-grounded admission input (the predicate + the graph state). */
export interface GraphAdmissionInput {
  readonly graph: ExecutionProofGraph;
  readonly dependent: ProofAdmissionInput['dependent'];
  readonly declaredParents: readonly string[];
  readonly predecessorEvidence: readonly PredecessorEvidence[];
  readonly trustPolicy: ProofAdmissionInput['trustPolicy'];
  readonly capabilityFacts?: ProofAdmissionInput['capabilityFacts'];
  readonly capabilityRequirement?: ProofAdmissionInput['capabilityRequirement'];
  readonly authorizationGrants?: ProofAdmissionInput['authorizationGrants'];
  readonly authorizationRequired?: ProofAdmissionInput['authorizationRequired'];
  readonly dependentCapability?: ProofAdmissionInput['dependentCapability'];
  readonly placementEligibility?: ProofAdmissionInput['placementEligibility'];
  readonly placementConstraint?: ProofAdmissionInput['placementConstraint'];
}

/**
 * Evaluate the dependent action's admission against the GRAPH STATE:
 *
 *   1. every declared parent digest must be present as a NODE in the graph
 *      (the causal history is reconstructable — evidence without graph
 *      membership is not enough);
 *   2. the verification-derived admission predicate runs over the supplied
 *      facts (verification → binding → freshness → assurance → trust →
 *      capability → authorization → placement, first failure wins).
 *
 * Deterministic and fail-closed: an empty graph denies every parent; an
 * extra unrelated node never satisfies a missing declared parent.
 */
export function evaluateGraphAdmission(input: GraphAdmissionInput): ProofAdmissionResult {
  const digestsInGraph = new Set(input.graph.nodes.map((node) => node.executionDigest));
  for (const parentDigest of [...input.declaredParents].sort()) {
    if (!digestsInGraph.has(parentDigest)) {
      return {
        admitted: false,
        failure: {
          code: 'ADMISSION_PARENT_MISSING',
          dimension: 'parents',
          detail: `the declared parent ${parentDigest} is not present as a node in the proof graph (the causal history is not reconstructable)`,
          parentDigest,
        },
      };
    }
  }
  return evaluateProofAdmission({
    dependent: input.dependent,
    declaredParents: input.declaredParents,
    predecessorEvidence: input.predecessorEvidence,
    trustPolicy: input.trustPolicy,
    ...(input.capabilityFacts !== undefined ? { capabilityFacts: input.capabilityFacts } : {}),
    ...(input.capabilityRequirement !== undefined ? { capabilityRequirement: input.capabilityRequirement } : {}),
    ...(input.authorizationGrants !== undefined ? { authorizationGrants: input.authorizationGrants } : {}),
    ...(input.authorizationRequired !== undefined ? { authorizationRequired: input.authorizationRequired } : {}),
    ...(input.dependentCapability !== undefined ? { dependentCapability: input.dependentCapability } : {}),
    ...(input.placementEligibility !== undefined ? { placementEligibility: input.placementEligibility } : {}),
    ...(input.placementConstraint !== undefined ? { placementConstraint: input.placementConstraint } : {}),
  });
}

// ============================================================================
// Idempotent fragment delivery (replay/duplicate convergence)
// ============================================================================

/** The deterministic tally of one fragment delivery. */
export interface GraphConvergenceResult {
  /** Pre-merge validation failures: the delivered fragment is internally inconsistent/mutated and was rejected WHOLE. */
  readonly fragmentRejected: readonly ProofGraphFailure[];
  readonly nodesAccepted: number;
  readonly nodesDuplicated: number;
  readonly nodesRejected: readonly ProofGraphFailure[];
  readonly edgesAccepted: number;
  readonly edgesDuplicated: number;
  readonly edgesRejected: readonly ProofGraphFailure[];
  /** True when nothing was rejected (duplicate convergence is still converged). */
  readonly converged: boolean;
  /** The final graph state after the delivery. */
  readonly graph: ExecutionProofGraph;
}

/**
 * Deliver a graph fragment into the builder, idempotently.
 *
 * Deterministic processing: the fragment's INTERNAL consistency is
 * validated FIRST (canonical ordering, identity derivations, scope
 * binding, endpoint-digest bindings, parent commitments — a mutated
 * fragment is rejected WHOLE, never partially merged); then nodes are
 * processed in canonical nodeIdentity order and edges in canonical
 * edgeIdentity order. Duplicate delivery converges (the same logical
 * facts, zero mutations, `converged: true`); a conflicting redefinition is
 * a typed rejection tallied in `nodesRejected`/`edgesRejected`
 * (append-only — the state is never rewritten).
 *
 * Edges are re-derived from the MERGED node set through the builder's own
 * derivation path (the caller supplies only endpoint identities), so a
 * fragment cannot smuggle arbitrary digests: every endpoint binding is
 * recomputed and re-validated.
 */
export function deliverGraphFragment(
  builder: ProofGraphBuilder,
  fragment: ExecutionProofGraph,
): GraphConvergenceResult {
  // 0. the fragment must be internally consistent (fail-closed: a mutated
  //    fragment is rejected WHOLE — never partially merged)
  const fragmentIssues = validateGraphConsistency(fragment);
  if (fragmentIssues.length > 0) {
    return {
      fragmentRejected: fragmentIssues,
      nodesAccepted: 0,
      nodesDuplicated: 0,
      nodesRejected: [],
      edgesAccepted: 0,
      edgesDuplicated: 0,
      edgesRejected: [],
      converged: false,
      graph: builder.graph,
    };
  }

  const nodesAccepted: number[] = [];
  const nodesDuplicated: number[] = [];
  const nodesRejected: ProofGraphFailure[] = [];
  const edgesAccepted: number[] = [];
  const edgesDuplicated: number[] = [];
  const edgesRejected: ProofGraphFailure[] = [];

  // 1. nodes, canonical order
  const sortedNodes = [...fragment.nodes].sort((a, b) => (a.nodeIdentity < b.nodeIdentity ? -1 : a.nodeIdentity > b.nodeIdentity ? 1 : 0));
  for (const node of sortedNodes) {
    const result = builder.addNode(node);
    if (result.kind === 'accepted') {
      nodesAccepted.push(1);
    } else if (result.kind === 'duplicate') {
      nodesDuplicated.push(1);
    } else {
      nodesRejected.push(result.failure);
    }
  }

  // 2. edges, canonical order — resolve endpoints through the MERGED node
  //    set (identity → node → attestation id → the builder's own derivation)
  const nodesByIdentity = new Map<string, { nodeIdentity: string; attestationId: string }>();
  for (const node of builder.graph.nodes) {
    nodesByIdentity.set(node.nodeIdentity, node);
  }
  const sortedEdges = [...fragment.edges].sort((a, b) => (a.edgeIdentity < b.edgeIdentity ? -1 : a.edgeIdentity > b.edgeIdentity ? 1 : 0));
  for (const edge of sortedEdges) {
    const parent = nodesByIdentity.get(edge.parentNode);
    const child = nodesByIdentity.get(edge.childNode);
    if (!parent || !child) {
      edgesRejected.push({
        code: 'GRAPH_EDGE_UNKNOWN_NODE',
        detail: `fragment edge endpoint is not present in the merged graph: ${!parent ? edge.parentNode : edge.childNode}`,
        identity: edge.edgeIdentity,
      });
      continue;
    }
    const result =
      edge.relation === 'causal'
        ? builder.addCausalEdge({ parentAttestationId: parent.attestationId, childAttestationId: child.attestationId })
        : builder.addDependencyEdge({ parentAttestationId: parent.attestationId, childAttestationId: child.attestationId, declaredBy: 'graph-fragment-delivery' });
    if (result.kind === 'accepted') {
      edgesAccepted.push(1);
    } else if (result.kind === 'duplicate') {
      edgesDuplicated.push(1);
    } else {
      edgesRejected.push(result.failure);
    }
  }

  return {
    fragmentRejected: [],
    nodesAccepted: nodesAccepted.length,
    nodesDuplicated: nodesDuplicated.length,
    nodesRejected,
    edgesAccepted: edgesAccepted.length,
    edgesDuplicated: edgesDuplicated.length,
    edgesRejected,
    converged: nodesRejected.length === 0 && edgesRejected.length === 0,
    graph: builder.graph,
  };
}

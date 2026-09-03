/**
 * V2-015 — internal/pure structural validation.
 *
 * Validates identity shapes, required references, deterministic ordering,
 * edge/node binding, append-only constraints and duplicate semantics for
 * proof-graph candidates and states.
 *
 * DELIBERATELY OUT OF SCOPE (the authority boundaries, pinned by the
 * architecture boundary battery):
 *   - NO signature verification (V2-014's authority — this file never
 *     touches cryptography beyond sha-256 identity derivations);
 *   - NO persistence mutation (V2-005's authority);
 *   - NO authorization (the authorization authority's);
 *   - NO placement evaluation (V2-009's authority);
 *   - NO workflow semantics (V2-003's authority).
 *
 * All functions are PURE: same input → same output, no clock, no randomness,
 * no network, no environment access.
 */

import { createHash } from 'node:crypto';
import {
  ATTESTATION_ID_PREFIX,
  ATTESTER_KEY_ID_PREFIX,
  canonicalJsonStringify,
  deriveAttestationIdentity,
  validateExecutionStatement,
  type ExecutionAttestation,
  type Sha256Hex,
  type UtcTimestamp,
} from '../../execution-attestation/index.js';
import {
  EXECUTION_PROOF_GRAPH_OBJECT_TYPE,
  EXECUTION_PROOF_GRAPH_SCHEMA_VERSION,
  PROOF_EDGE_ID_DOMAIN,
  PROOF_EDGE_ID_PREFIX,
  PROOF_EDGE_RELATIONS,
  PROOF_GRAPH_ID_DOMAIN,
  PROOF_GRAPH_ID_PREFIX,
  PROOF_NODE_ID_DOMAIN,
  PROOF_NODE_ID_PREFIX,
  PROOF_PARENT_COMMITMENT_DOMAIN,
} from '../types.js';
import type {
  ExecutionProofEdge,
  ExecutionProofGraph,
  ExecutionProofNode,
  ProofEdgeRelation,
  ProofGraphFailure,
} from '../types.js';

// ============================================================================
// Deterministic identity derivations (sha-256, domain-separated)
// ============================================================================

function sha256HexOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The stable graph identity for one (workflow, version, run) scope. */
export function deriveGraphIdentity(scope: {
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly runId: string;
}): string {
  return (
    PROOF_GRAPH_ID_PREFIX +
    sha256HexOf(
      canonicalJsonStringify({
        domain: PROOF_GRAPH_ID_DOMAIN,
        workflowId: scope.workflowId,
        workflowVersionId: scope.workflowVersionId,
        runId: scope.runId,
      }),
    )
  );
}

/** The stable graph-node identity for one attestation identity. */
export function deriveProofNodeIdentity(attestationId: string): string {
  return (
    PROOF_NODE_ID_PREFIX +
    sha256HexOf(
      canonicalJsonStringify({
        domain: PROOF_NODE_ID_DOMAIN,
        attestationId,
      }),
    )
  );
}

/** The stable graph-edge identity for one (relation, parent, child) triple. */
export function deriveProofEdgeIdentity(input: {
  readonly relation: ProofEdgeRelation;
  readonly parentExecutionDigest: Sha256Hex;
  readonly childExecutionDigest: Sha256Hex;
}): string {
  return (
    PROOF_EDGE_ID_PREFIX +
    sha256HexOf(
      canonicalJsonStringify({
        domain: PROOF_EDGE_ID_DOMAIN,
        relation: input.relation,
        parentExecutionDigest: input.parentExecutionDigest,
        childExecutionDigest: input.childExecutionDigest,
      }),
    )
  );
}

/** The parent commitment over the sorted declared causal-parent digests. */
export function deriveParentCommitment(declaredCausalParents: readonly Sha256Hex[]): string {
  return sha256HexOf(
    canonicalJsonStringify({
      domain: PROOF_PARENT_COMMITMENT_DOMAIN,
      causalParents: [...declaredCausalParents].sort(),
    }),
  );
}

// ============================================================================
// Shape guards (pure)
// ============================================================================

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

export function isUtcTimestamp(value: string): boolean {
  return UTC_TIMESTAMP.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** ISO epoch millis comparison for fixed-format UTC timestamps (pure). */
export function compareUtcTimestamps(a: UtcTimestamp, b: UtcTimestamp): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parse a fixed-format UTC timestamp to epoch millis (pure; no Date object). */
export function utcTimestampToEpochMs(value: UtcTimestamp): number {
  if (!isUtcTimestamp(value)) {
    throw new Error(`not a fixed-format UTC timestamp: ${value}`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const millis = Number(value.slice(20, 23));
  // days from civil algorithm (Howard Hinnant) — pure integer arithmetic
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  return ((days * 24 + hour) * 60 + minute) * 60 * 1000 + second * 1000 + millis;
}

// ============================================================================
// Node candidate validation (structural — never cryptographic)
// ============================================================================

/**
 * Project an attestation envelope to its graph node (deterministic
 * projection) — AFTER structural validation passes. The projection is pure:
 * the node carries identity/binding/parent data only (never the signature
 * or the public key).
 */
export function projectAttestationToNode(attestation: ExecutionAttestation): ExecutionProofNode {
  const declared = [...attestation.statement.causalParents].sort();
  return {
    nodeIdentity: deriveProofNodeIdentity(attestation.attestationId),
    attestationId: attestation.attestationId,
    executionDigest: attestation.executionDigest.digest,
    attesterKeyId: attestation.attesterKeyId,
    assurance: attestation.assurance,
    outcome: attestation.statement.outcome,
    workflowId: attestation.statement.workflowId,
    workflowVersionId: attestation.statement.workflowVersionId,
    workflowVersionSemanticDigest: attestation.statement.workflowVersionSemanticDigest,
    runId: attestation.statement.runId,
    attemptId: attestation.statement.attemptId,
    stepId: attestation.statement.stepId ?? null,
    executorNodeId: attestation.statement.nodeId,
    declaredCausalParents: declared,
    parentCommitment: deriveParentCommitment(declared),
  };
}

/**
 * Structurally validate an attestation as a graph-node candidate.
 *
 * Uses the MERGED V2-014 public statement validator (the merged public
 * surface — never a re-implementation) plus graph-specific coherence:
 *   - the envelope's attestation identity must equal the V2-014 public
 *     derivation from (executionDigest, attesterKeyId) — structural
 *     coherence of the identity the node binds;
 *   - the execution digest must be a sha-256 hex digest in the V2-014
 *     statement domain;
 *   - prefix/vocabulary shape checks for the identities the node carries.
 *
 * Returns typed issues; NEVER verifies the signature (V2-014's authority,
 * exercised per-admission on the verification path, not at graph assembly).
 */
export function validateNodeCandidate(attestation: ExecutionAttestation): readonly ProofGraphFailure[] {
  const issues: ProofGraphFailure[] = [];

  const statementValidation = validateExecutionStatement(attestation.statement);
  if (!statementValidation.ok) {
    for (const issue of statementValidation.issues) {
      issues.push({
        code: 'GRAPH_NODE_INVALID',
        detail: `bound statement invalid at ${issue.path}: ${issue.message}`,
      });
    }
  }

  if (
    attestation.attestationId !==
    deriveAttestationIdentity(attestation.executionDigest.digest, attestation.attesterKeyId)
  ) {
    issues.push({
      code: 'GRAPH_NODE_INVALID',
      detail: 'attestationId does not match the V2-014 public derivation from (executionDigest, attesterKeyId)',
      identity: attestation.attestationId,
    });
  }

  if (!attestation.attestationId.startsWith(ATTESTATION_ID_PREFIX)) {
    issues.push({
      code: 'GRAPH_NODE_INVALID',
      detail: `attestationId must carry the ${ATTESTATION_ID_PREFIX} prefix`,
      identity: attestation.attestationId,
    });
  }

  if (!attestation.attesterKeyId.startsWith(ATTESTER_KEY_ID_PREFIX)) {
    issues.push({
      code: 'GRAPH_NODE_INVALID',
      detail: `attesterKeyId must carry the ${ATTESTER_KEY_ID_PREFIX} prefix`,
    });
  }

  if (attestation.executionDigest.domain !== 'workflowos/execution-statement/v1') {
    issues.push({
      code: 'GRAPH_NODE_INVALID',
      detail: `executionDigest domain must be the V2-014 statement domain (got ${attestation.executionDigest.domain})`,
    });
  }

  if (attestation.executionDigest.algorithm !== 'sha-256' || !isSha256Hex(attestation.executionDigest.digest)) {
    issues.push({
      code: 'GRAPH_NODE_INVALID',
      detail: 'executionDigest must be a sha-256 hex digest',
    });
  }

  for (const digest of attestation.statement.causalParents) {
    if (!isSha256Hex(digest)) {
      issues.push({
        code: 'GRAPH_NODE_INVALID',
        detail: `declared causal parent is not a sha-256 hex digest: ${digest}`,
      });
    }
  }

  return issues;
}

// ============================================================================
// Edge candidate validation (structural)
// ============================================================================

/**
 * Structurally validate an edge candidate against the graph's node set.
 *
 *   - both endpoints must exist in the graph (missing-parent rejection);
 *   - a self-edge is rejected;
 *   - the edge's endpoint digest bindings must equal the bound nodes'
 *     execution digests (the coordinator cannot re-wire an edge);
 *   - a CAUSAL edge's parent digest must appear in the child node's
 *     declaredCausalParents (the child's own statement declared it);
 *   - relation must be a known relation;
 *   - the edge identity must equal the deterministic derivation.
 */
export function validateEdgeCandidate(
  graph: ExecutionProofGraph,
  candidate: ExecutionProofEdge,
): readonly ProofGraphFailure[] {
  const issues: ProofGraphFailure[] = [];

  if (!PROOF_EDGE_RELATIONS.includes(candidate.relation)) {
    issues.push({
      code: 'GRAPH_EDGE_INVALID',
      detail: `unknown edge relation: ${String(candidate.relation)}`,
      identity: candidate.edgeIdentity,
    });
    return issues;
  }

  const parentNode = graph.nodes.find((n) => n.nodeIdentity === candidate.parentNode);
  const childNode = graph.nodes.find((n) => n.nodeIdentity === candidate.childNode);
  if (!parentNode) {
    issues.push({
      code: 'GRAPH_EDGE_UNKNOWN_NODE',
      detail: `parent node not present in the graph: ${candidate.parentNode}`,
      identity: candidate.parentNode,
    });
  }
  if (!childNode) {
    issues.push({
      code: 'GRAPH_EDGE_UNKNOWN_NODE',
      detail: `child node not present in the graph: ${candidate.childNode}`,
      identity: candidate.childNode,
    });
  }

  if (candidate.parentNode === candidate.childNode) {
    issues.push({
      code: 'GRAPH_EDGE_SELF_LOOP',
      detail: 'a proof edge cannot relate a node to itself',
      identity: candidate.parentNode,
    });
  }

  if (parentNode && parentNode.executionDigest !== candidate.parentExecutionDigest) {
    issues.push({
      code: 'GRAPH_EDGE_INVALID',
      detail: 'edge parent digest does not equal the parent node execution digest (endpoint binding broken)',
      identity: candidate.edgeIdentity,
    });
  }
  if (childNode && childNode.executionDigest !== candidate.childExecutionDigest) {
    issues.push({
      code: 'GRAPH_EDGE_INVALID',
      detail: 'edge child digest does not equal the child node execution digest (endpoint binding broken)',
      identity: candidate.edgeIdentity,
    });
  }

  if (candidate.relation === 'causal' && childNode && !childNode.declaredCausalParents.includes(candidate.parentExecutionDigest)) {
    issues.push({
      code: 'GRAPH_EDGE_PARENT_UNDECLARED',
      detail: 'causal edge parent digest is not declared by the child attestation statement',
      identity: candidate.edgeIdentity,
    });
  }

  const expectedIdentity = deriveProofEdgeIdentity({
    relation: candidate.relation,
    parentExecutionDigest: candidate.parentExecutionDigest,
    childExecutionDigest: candidate.childExecutionDigest,
  });
  if (candidate.edgeIdentity !== expectedIdentity) {
    issues.push({
      code: 'GRAPH_EDGE_INVALID',
      detail: 'edgeIdentity does not match the deterministic derivation from (relation, parent digest, child digest)',
      identity: candidate.edgeIdentity,
    });
  }

  return issues;
}

// ============================================================================
// Graph state validation (shape + canonical ordering + scope)
// ============================================================================

/**
 * Validate a graph state's CONSISTENCY (identity derivations, scope
 * binding, endpoint bindings, parent commitments, duplicates) WITHOUT the
 * canonical-ordering checks — fragment delivery accepts any arrival order
 * and canonicalizes on merge.
 */
export function validateGraphConsistency(graph: ExecutionProofGraph): readonly ProofGraphFailure[] {
  const issues: ProofGraphFailure[] = [];
  return validateGraphStateInternal(graph, issues, false);
}

/** Validate a graph state's shape, canonical ordering, and binding coherence. */
export function validateGraphState(graph: ExecutionProofGraph): readonly ProofGraphFailure[] {
  const issues: ProofGraphFailure[] = [];
  return validateGraphStateInternal(graph, issues, true);
}

function validateGraphStateInternal(
  graph: ExecutionProofGraph,
  issues: ProofGraphFailure[],
  checkOrdering: boolean,
): readonly ProofGraphFailure[] {

  if (graph.objectType !== EXECUTION_PROOF_GRAPH_OBJECT_TYPE) {
    issues.push({
      code: 'GRAPH_SERIALIZATION_INVALID',
      detail: `objectType must be exactly ${EXECUTION_PROOF_GRAPH_OBJECT_TYPE}`,
    });
  }
  if (graph.schemaVersion !== EXECUTION_PROOF_GRAPH_SCHEMA_VERSION) {
    issues.push({
      code: 'GRAPH_SERIALIZATION_INVALID',
      detail: `schemaVersion must be exactly ${EXECUTION_PROOF_GRAPH_SCHEMA_VERSION}`,
    });
  }
  if (!isNonEmptyString(graph.graphIdentity) || !graph.graphIdentity.startsWith(PROOF_GRAPH_ID_PREFIX)) {
    issues.push({
      code: 'GRAPH_SERIALIZATION_INVALID',
      detail: `graphIdentity must carry the ${PROOF_GRAPH_ID_PREFIX} prefix`,
      identity: graph.graphIdentity,
    });
  }
  const expectedIdentity = deriveGraphIdentity({
    workflowId: graph.workflowId,
    workflowVersionId: graph.workflowVersionId,
    runId: graph.runId,
  });
  if (graph.graphIdentity !== expectedIdentity) {
    issues.push({
      code: 'GRAPH_SERIALIZATION_INVALID',
      detail: 'graphIdentity does not match the deterministic derivation from (workflow, version, run)',
      identity: graph.graphIdentity,
    });
  }

  const nodeIds = graph.nodes.map((n) => n.nodeIdentity);
  const sortedNodeIds = [...nodeIds].sort();
  if (checkOrdering && nodeIds.some((id, i) => id !== sortedNodeIds[i])) {
    issues.push({
      code: 'GRAPH_SERIALIZATION_INVALID',
      detail: 'nodes are not in canonical nodeIdentity order',
    });
  }
  const seenNodeIds = new Set<string>();
  for (const id of nodeIds) {
    if (seenNodeIds.has(id)) {
      issues.push({
        code: 'GRAPH_SERIALIZATION_INVALID',
        detail: `duplicate node identity: ${id}`,
        identity: id,
      });
    }
    seenNodeIds.add(id);
    if (!id.startsWith(PROOF_NODE_ID_PREFIX)) {
      issues.push({
        code: 'GRAPH_SERIALIZATION_INVALID',
        detail: `node identity must carry the ${PROOF_NODE_ID_PREFIX} prefix`,
        identity: id,
      });
    }
  }

  for (const node of graph.nodes) {
    if (node.nodeIdentity !== deriveProofNodeIdentity(node.attestationId)) {
      issues.push({
        code: 'GRAPH_SERIALIZATION_INVALID',
        detail: 'node identity does not match its attestation binding',
        identity: node.nodeIdentity,
      });
    }
    if (node.parentCommitment !== deriveParentCommitment(node.declaredCausalParents)) {
      issues.push({
        code: 'GRAPH_SERIALIZATION_INVALID',
        detail: 'parent commitment does not match the declared causal parents (mutated parent relationships)',
        identity: node.nodeIdentity,
      });
    }
    const declaredSorted = [...node.declaredCausalParents].sort();
    if (checkOrdering && node.declaredCausalParents.some((d, i) => d !== declaredSorted[i])) {
      issues.push({
        code: 'GRAPH_SERIALIZATION_INVALID',
        detail: 'declared causal parents are not in canonical sorted order',
        identity: node.nodeIdentity,
      });
    }
    if (node.declaredCausalParents.some((d) => !isSha256Hex(d))) {
      issues.push({
        code: 'GRAPH_SERIALIZATION_INVALID',
        detail: 'declared causal parents must be sha-256 hex digests',
        identity: node.nodeIdentity,
      });
    }
    if (
      !isNonEmptyString(node.attestationId) ||
      !isNonEmptyString(node.executionDigest) ||
      !isSha256Hex(node.executionDigest)
    ) {
      issues.push({
        code: 'GRAPH_SERIALIZATION_INVALID',
        detail: 'node binding identities are malformed',
        identity: node.nodeIdentity,
      });
    }
    if (
      node.workflowId !== graph.workflowId ||
      node.workflowVersionId !== graph.workflowVersionId ||
      node.runId !== graph.runId
    ) {
      issues.push({
        code: 'GRAPH_SCOPE_MISMATCH',
        detail: 'node does not belong to this graph scope (workflow/version/run binding broken)',
        identity: node.nodeIdentity,
      });
    }
  }

  const edgeIds = graph.edges.map((e) => e.edgeIdentity);
  const sortedEdgeIds = [...edgeIds].sort();
  if (checkOrdering && edgeIds.some((id, i) => id !== sortedEdgeIds[i])) {
    issues.push({
      code: 'GRAPH_SERIALIZATION_INVALID',
      detail: 'edges are not in canonical edgeIdentity order',
    });
  }
  const seenEdgeIds = new Set<string>();
  for (const id of edgeIds) {
    if (seenEdgeIds.has(id)) {
      issues.push({
        code: 'GRAPH_SERIALIZATION_INVALID',
        detail: `duplicate edge identity: ${id}`,
        identity: id,
      });
    }
    seenEdgeIds.add(id);
  }
  for (const edge of graph.edges) {
    const edgeIssues = validateEdgeCandidate(graph, edge);
    issues.push(...edgeIssues);
  }

  return issues;
}

// ============================================================================
// Cycle detection (pure, deterministic)
// ============================================================================

/**
 * Would adding the directed edge (parent → child) introduce a cycle in the
 * graph's combined edge set? A cycle exists iff the PARENT is already
 * reachable FROM THE CHILD by following existing edges forward
 * (child ⊢* parent): the new edge parent→child would then close the loop
 * child ⊢* parent → child. Deterministic traversal in canonical order.
 */
export function edgeWouldCreateCycle(
  graph: ExecutionProofGraph,
  parent: string,
  child: string,
): boolean {
  // downstream adjacency: parent → children (edges flow parent → child)
  const downstream = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = downstream.get(edge.parentNode) ?? [];
    list.push(edge.childNode);
    downstream.set(edge.parentNode, list);
  }
  const visited = new Set<string>();
  let frontier: string[] = [child];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of frontier) {
      if (node === parent) {
        return true;
      }
      if (visited.has(node)) {
        continue;
      }
      visited.add(node);
      for (const c of (downstream.get(node) ?? []).slice().sort()) {
        if (!visited.has(c)) {
          next.push(c);
        }
      }
    }
    frontier = next.sort();
  }
  return false;
}

// ============================================================================
// Append-only / duplicate semantics (pure)
// ============================================================================

/**
 * Compare a candidate node against an existing node with the same identity.
 * Returns 'identical' (duplicate delivery — converges), or 'conflict' (the
 * same identity carrying different content — append-only violation, typed
 * rejection; NEVER last-write-wins).
 */
export function compareNodeForAppend(
  existing: ExecutionProofNode,
  candidate: ExecutionProofNode,
): 'identical' | 'conflict' {
  return nodesEqual(existing, candidate) ? 'identical' : 'conflict';
}

/** Structural equality of two nodes (canonical field-by-field). */
export function nodesEqual(a: ExecutionProofNode, b: ExecutionProofNode): boolean {
  return canonicalJsonStringify(nodeToComparable(a)) === canonicalJsonStringify(nodeToComparable(b));
}

function nodeToComparable(node: ExecutionProofNode): Record<string, unknown> {
  return {
    nodeIdentity: node.nodeIdentity,
    attestationId: node.attestationId,
    executionDigest: node.executionDigest,
    attesterKeyId: node.attesterKeyId,
    assurance: node.assurance,
    outcome: node.outcome,
    workflowId: node.workflowId,
    workflowVersionId: node.workflowVersionId,
    workflowVersionSemanticDigest: node.workflowVersionSemanticDigest,
    runId: node.runId,
    attemptId: node.attemptId,
    stepId: node.stepId,
    executorNodeId: node.executorNodeId,
    declaredCausalParents: [...node.declaredCausalParents],
    parentCommitment: node.parentCommitment,
  };
}

/** Structural equality of two edges (canonical field-by-field). */
export function edgesEqual(a: ExecutionProofEdge, b: ExecutionProofEdge): boolean {
  return (
    a.edgeIdentity === b.edgeIdentity &&
    a.relation === b.relation &&
    a.parentNode === b.parentNode &&
    a.childNode === b.childNode &&
    a.parentExecutionDigest === b.parentExecutionDigest &&
    a.childExecutionDigest === b.childExecutionDigest
  );
}

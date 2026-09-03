/**
 * V2-015 — internal/canonical graph serialization.
 *
 * Byte-deterministic serialization of the append-only proof-graph state:
 *   - the serialized form carries the schema/version identity and ALL
 *     integrity-critical fields (graph identity + scope binding + every
 *     node/edge binding field);
 *   - nodes, edges and parent lists are canonically ordered (sorted), so
 *     insertion order NEVER changes the bytes (deterministic ordering,
 *     invariant 3);
 *   - `computeGraphDigest` is sha-256 over the canonical serialization —
 *     the coordinator-mutation detection commitment at graph level
 *     (invariant 10: any alteration changes the digest or breaks a typed
 *     structural validation);
 *   - `parseProofGraph` is fail-closed and typed: structural shape +
 *     canonical ordering + identity derivations + scope binding +
 *     endpoint-digest binding + parent commitments are ALL validated before
 *     a graph is accepted back.
 *
 * Uses the merged V2-014 public canonical-JSON discipline
 * (`canonicalJsonStringify`) — the public cross-client byte-equality
 * utility; never a re-implementation.
 */

import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../../execution-attestation/index.js';
import {
  EXECUTION_PROOF_GRAPH_OBJECT_TYPE,
  EXECUTION_PROOF_GRAPH_SCHEMA_VERSION,
  PROOF_EDGE_ID_PREFIX,
  PROOF_GRAPH_ID_PREFIX,
  PROOF_NODE_ID_PREFIX,
} from '../types.js';
import type {
  ExecutionProofEdge,
  ExecutionProofGraph,
  ExecutionProofNode,
  ProofGraphFailure,
} from '../types.js';
import { validateGraphState } from './validation.js';

// ============================================================================
// Serialization (canonical, byte-deterministic)
// ============================================================================

/** The canonical serializable projection of a node (sorted parent lists). */
interface SerializedNode {
  readonly nodeIdentity: string;
  readonly attestationId: string;
  readonly executionDigest: string;
  readonly attesterKeyId: string;
  readonly assurance: string;
  readonly outcome: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowVersionSemanticDigest: string;
  readonly runId: string;
  readonly attemptId: number;
  readonly stepId: string | null;
  readonly executorNodeId: string;
  readonly declaredCausalParents: readonly string[];
  readonly parentCommitment: string;
}

/** The canonical serializable projection of an edge. */
interface SerializedEdge {
  readonly edgeIdentity: string;
  readonly relation: string;
  readonly parentNode: string;
  readonly childNode: string;
  readonly parentExecutionDigest: string;
  readonly childExecutionDigest: string;
}

function toSerializedNode(node: ExecutionProofNode): SerializedNode {
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
    declaredCausalParents: [...node.declaredCausalParents].sort(),
    parentCommitment: node.parentCommitment,
  };
}

function toSerializedEdge(edge: ExecutionProofEdge): SerializedEdge {
  return {
    edgeIdentity: edge.edgeIdentity,
    relation: edge.relation,
    parentNode: edge.parentNode,
    childNode: edge.childNode,
    parentExecutionDigest: edge.parentExecutionDigest,
    childExecutionDigest: edge.childExecutionDigest,
  };
}

/**
 * Serialize the graph canonically. The output is a JSON object whose keys are
 * canonicalized by the merged V2-014 canonical-JSON discipline and whose
 * arrays are canonically sorted — byte-deterministic over the LOGICAL state,
 * independent of insertion history.
 */
export function serializeProofGraph(graph: ExecutionProofGraph): string {
  return canonicalJsonStringify({
    objectType: graph.objectType,
    schemaVersion: graph.schemaVersion,
    graphIdentity: graph.graphIdentity,
    workflowId: graph.workflowId,
    workflowVersionId: graph.workflowVersionId,
    workflowVersionSemanticDigest: graph.workflowVersionSemanticDigest,
    runId: graph.runId,
    nodes: [...graph.nodes].sort((a, b) => (a.nodeIdentity < b.nodeIdentity ? -1 : a.nodeIdentity > b.nodeIdentity ? 1 : 0)).map(toSerializedNode),
    edges: [...graph.edges].sort((a, b) => (a.edgeIdentity < b.edgeIdentity ? -1 : a.edgeIdentity > b.edgeIdentity ? 1 : 0)).map(toSerializedEdge),
  });
}

/**
 * The graph digest: sha-256 over the canonical serialization. Two logically
 * equal graphs have equal digests; ANY mutation changes the digest or breaks
 * a typed structural validation during parse (mutation detection).
 */
export function computeGraphDigest(graph: ExecutionProofGraph): string {
  return createHash('sha256').update(serializeProofGraph(graph), 'utf8').digest('hex');
}

// ============================================================================
// Deserialization (fail-closed, typed)
// ============================================================================

export type ProofGraphParseResult =
  | { readonly ok: true; readonly graph: ExecutionProofGraph }
  | { readonly ok: false; readonly failure: ProofGraphFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFailure(detail: string, identity?: string): ProofGraphParseResult {
  return {
    ok: false,
    failure: {
      code: 'GRAPH_SERIALIZATION_INVALID',
      detail,
      ...(identity !== undefined ? { identity } : {}),
    },
  };
}

/**
 * Parse + fully validate a serialized proof graph. Fail-closed: every
 * structural invariant (shape, ordering, identity derivations, scope
 * binding, endpoint bindings, parent commitments, cycles) is enforced before
 * the graph is accepted.
 */
export function parseProofGraph(serialized: string): ProofGraphParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return parseFailure('payload is not valid JSON');
  }
  if (!isRecord(raw)) {
    return parseFailure('payload is not a JSON object');
  }

  if (raw['objectType'] !== EXECUTION_PROOF_GRAPH_OBJECT_TYPE) {
    return parseFailure(`objectType must be exactly ${EXECUTION_PROOF_GRAPH_OBJECT_TYPE}`);
  }
  if (raw['schemaVersion'] !== EXECUTION_PROOF_GRAPH_SCHEMA_VERSION) {
    return parseFailure(`schemaVersion must be exactly ${EXECUTION_PROOF_GRAPH_SCHEMA_VERSION}`);
  }
  const graphIdentity = raw['graphIdentity'];
  if (typeof graphIdentity !== 'string' || !graphIdentity.startsWith(PROOF_GRAPH_ID_PREFIX)) {
    return parseFailure(`graphIdentity must carry the ${PROOF_GRAPH_ID_PREFIX} prefix`);
  }

  const nodesRaw = raw['nodes'];
  const edgesRaw = raw['edges'];
  if (!Array.isArray(nodesRaw)) {
    return parseFailure('nodes must be an array');
  }
  if (!Array.isArray(edgesRaw)) {
    return parseFailure('edges must be an array');
  }

  const nodes: ExecutionProofNode[] = [];
  for (const candidate of nodesRaw) {
    if (!isRecord(candidate)) {
      return parseFailure('every node must be an object');
    }
    const node = parseNode(candidate);
    if (!node.ok) {
      return node;
    }
    nodes.push(node.node);
  }

  const edges: ExecutionProofEdge[] = [];
  for (const candidate of edgesRaw) {
    if (!isRecord(candidate)) {
      return parseFailure('every edge must be an object');
    }
    const edge = parseEdge(candidate);
    if (!edge.ok) {
      return edge;
    }
    edges.push(edge.edge);
  }

  // The top-level binding fields are constructed through the same throwing
  // guards the per-node/per-edge parsers use — but HERE they sit inside the
  // parse boundary: a missing/malformed workflowId, workflowVersionId,
  // workflowVersionSemanticDigest or runId is converted to the TYPED
  // fail-closed `GRAPH_SERIALIZATION_INVALID` result, NEVER an escaped
  // exception (the public contract is ProofGraphParseResult, ok: false).
  let graph: ExecutionProofGraph;
  try {
    graph = {
      objectType: EXECUTION_PROOF_GRAPH_OBJECT_TYPE,
      schemaVersion: EXECUTION_PROOF_GRAPH_SCHEMA_VERSION,
      graphIdentity,
      workflowId: asNonEmptyString(raw['workflowId'], 'workflowId'),
      workflowVersionId: asNonEmptyString(raw['workflowVersionId'], 'workflowVersionId'),
      workflowVersionSemanticDigest: asSha256(raw['workflowVersionSemanticDigest'], 'workflowVersionSemanticDigest'),
      runId: asNonEmptyString(raw['runId'], 'runId'),
      nodes,
      edges,
    };
  } catch (error) {
    return parseFailure(error instanceof Error ? error.message : 'graph top-level binding fields are malformed');
  }

  // the FULL structural battery (ordering, derivations, scope, endpoints,
  // parent commitments, cycles) runs before acceptance
  const issues = validateGraphState(graph);
  if (issues.length > 0) {
    return { ok: false, failure: issues[0]! };
  }
  return { ok: true, graph };
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function asSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be a sha-256 hex digest`);
  }
  return value;
}

function malformed(detail: string): ProofGraphFailure {
  return { code: 'GRAPH_SERIALIZATION_INVALID', detail };
}

function parseNode(candidate: Record<string, unknown>): { ok: true; node: ExecutionProofNode } | { ok: false; failure: ProofGraphFailure } {
  try {
    const node: ExecutionProofNode = {
      nodeIdentity: asPrefixedString(candidate['nodeIdentity'], PROOF_NODE_ID_PREFIX, 'nodeIdentity'),
      attestationId: asNonEmptyString(candidate['attestationId'], 'attestationId'),
      executionDigest: asSha256(candidate['executionDigest'], 'executionDigest'),
      attesterKeyId: asNonEmptyString(candidate['attesterKeyId'], 'attesterKeyId'),
      assurance: asAssurance(candidate['assurance']),
      outcome: asOutcome(candidate['outcome']),
      workflowId: asNonEmptyString(candidate['workflowId'], 'workflowId'),
      workflowVersionId: asNonEmptyString(candidate['workflowVersionId'], 'workflowVersionId'),
      workflowVersionSemanticDigest: asSha256(candidate['workflowVersionSemanticDigest'], 'workflowVersionSemanticDigest'),
      runId: asNonEmptyString(candidate['runId'], 'runId'),
      attemptId: asPositiveInt(candidate['attemptId'], 'attemptId'),
      stepId: asNullableString(candidate['stepId'], 'stepId'),
      executorNodeId: asNonEmptyString(candidate['executorNodeId'], 'executorNodeId'),
      declaredCausalParents: asSha256Array(candidate['declaredCausalParents'], 'declaredCausalParents'),
      parentCommitment: asSha256(candidate['parentCommitment'], 'parentCommitment'),
    };
    return { ok: true, node };
  } catch (error) {
    return { ok: false, failure: malformed(error instanceof Error ? error.message : 'node is malformed') };
  }
}

function parseEdge(candidate: Record<string, unknown>): { ok: true; edge: ExecutionProofEdge } | { ok: false; failure: ProofGraphFailure } {
  try {
    const relation = candidate['relation'];
    if (relation !== 'causal' && relation !== 'dependency') {
      return { ok: false, failure: malformed('edge relation must be "causal" or "dependency"') };
    }
    const edge: ExecutionProofEdge = {
      edgeIdentity: asPrefixedString(candidate['edgeIdentity'], PROOF_EDGE_ID_PREFIX, 'edgeIdentity'),
      relation,
      parentNode: asPrefixedString(candidate['parentNode'], PROOF_NODE_ID_PREFIX, 'parentNode'),
      childNode: asPrefixedString(candidate['childNode'], PROOF_NODE_ID_PREFIX, 'childNode'),
      parentExecutionDigest: asSha256(candidate['parentExecutionDigest'], 'parentExecutionDigest'),
      childExecutionDigest: asSha256(candidate['childExecutionDigest'], 'childExecutionDigest'),
    };
    return { ok: true, edge };
  } catch (error) {
    return { ok: false, failure: malformed(error instanceof Error ? error.message : 'edge is malformed') };
  }
}

function asPrefixedString(value: unknown, prefix: string, field: string): string {
  const str = asNonEmptyString(value, field);
  if (!str.startsWith(prefix)) {
    throw new Error(`${field} must carry the ${prefix} prefix`);
  }
  return str;
}

function asAssurance(value: unknown): 'software_signed' | 'hardware_backed' | 'tee_attested' | 'verifiable_computation' {
  if (value === 'software_signed' || value === 'hardware_backed' || value === 'tee_attested' || value === 'verifiable_computation') {
    return value;
  }
  throw new Error('assurance must be a canonical assurance level');
}

function asOutcome(value: unknown): 'succeeded' | 'failed' {
  if (value === 'succeeded' || value === 'failed') {
    return value;
  }
  throw new Error('outcome must be "succeeded" or "failed"');
}

function asPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer >= 1`);
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return asNonEmptyString(value, field);
}

function asSha256Array(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((entry) => asSha256(entry, field));
}

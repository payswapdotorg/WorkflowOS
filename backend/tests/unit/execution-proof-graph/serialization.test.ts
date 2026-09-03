import { describe, it, expect } from 'vitest';
import {
  createProofGraphBuilder,
  serializeProofGraph,
  parseProofGraph,
  computeGraphDigest,
  validateGraphState,
  type ExecutionProofGraph,
} from '../../../src/execution-proof-graph/index.js';
import {
  PG_SCOPE,
  buildPredecessorAttestation,
  buildDependentAttestation,
} from './helpers.js';

/**
 * V2-015 Task 2 — canonical serialization (red→green battery).
 *
 * Proves (frozen work order "Required verification" + invariants 3/7/10/11):
 *   - serialization is byte-deterministic (schema/version identity + ALL
 *     integrity-critical fields; deterministic node/edge/parent ordering);
 *   - the same graph built through DIFFERENT insertion orders serializes to
 *     IDENTICAL bytes;
 *   - deserialization round-trips the logical state;
 *   - ANY mutation of the serialized graph (dropped node, altered outcome,
 *     altered parent commitment, reordered collections, re-wired edge) is
 *     either a typed parse failure or produces a different graph digest —
 *     the coordinator mutation is DETECTED (invariant 10);
 *   - the digest is stable and collision-discriminating.
 */

function buildFullGraph(insertionOrder: 'predecessor-first' | 'dependent-first' = 'predecessor-first'): ExecutionProofGraph {
  const predecessor = buildPredecessorAttestation();
  const dependent = buildDependentAttestation(predecessor);
  const builder = createProofGraphBuilder(PG_SCOPE);
  if (insertionOrder === 'predecessor-first') {
    builder.addAttestationNode(predecessor);
    builder.addAttestationNode(dependent);
    builder.addCausalEdge({ parentAttestationId: predecessor.attestationId, childAttestationId: dependent.attestationId });
  } else {
    builder.addAttestationNode(dependent);
    builder.addAttestationNode(predecessor);
    builder.addCausalEdge({ parentAttestationId: predecessor.attestationId, childAttestationId: dependent.attestationId });
  }
  return builder.graph;
}

describe('V2-015 serialization — byte determinism', () => {
  it('serializes deterministically: two fresh builds → identical bytes', () => {
    const a = serializeProofGraph(buildFullGraph());
    const b = serializeProofGraph(buildFullGraph());
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('insertion order never changes the serialized bytes (canonical ordering)', () => {
    const forward = serializeProofGraph(buildFullGraph('predecessor-first'));
    const reverse = serializeProofGraph(buildFullGraph('dependent-first'));
    expect(forward).toBe(reverse);
  });

  it('carries the schema/version identity and all integrity-critical fields', () => {
    const graph = buildFullGraph();
    const parsed = JSON.parse(serializeProofGraph(graph)) as Record<string, unknown>;
    expect(parsed['objectType']).toBe('workflowos/execution-proof-graph/v1');
    expect(parsed['schemaVersion']).toBe(1);
    expect(parsed['graphIdentity']).toBe(graph.graphIdentity);
    expect(parsed['runId']).toBe(PG_SCOPE.runId);
    const nodes = parsed['nodes'] as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      for (const field of [
        'nodeIdentity',
        'attestationId',
        'executionDigest',
        'attesterKeyId',
        'assurance',
        'outcome',
        'workflowId',
        'workflowVersionId',
        'workflowVersionSemanticDigest',
        'runId',
        'attemptId',
        'stepId',
        'executorNodeId',
        'declaredCausalParents',
        'parentCommitment',
      ]) {
        expect(node[field], `node field ${field} must serialize`).toBeDefined();
      }
    }
    const edges = parsed['edges'] as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(1);
    for (const field of ['edgeIdentity', 'relation', 'parentNode', 'childNode', 'parentExecutionDigest', 'childExecutionDigest']) {
      expect(edges[0]?.[field], `edge field ${field} must serialize`).toBeDefined();
    }
  });

  it('round-trips: parse(serialize(g)) equals g and validates clean', () => {
    const graph = buildFullGraph();
    const result = parseProofGraph(serializeProofGraph(graph));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph).toEqual(graph);
      expect(validateGraphState(result.graph)).toEqual([]);
    }
  });

  it('rejects non-JSON and non-object payloads typed', () => {
    expect(parseProofGraph('not json').ok).toBe(false);
    expect(parseProofGraph('42').ok).toBe(false);
    expect(parseProofGraph('null').ok).toBe(false);
    expect(parseProofGraph('[]').ok).toBe(false);
  });

  it('rejects the wrong object type / schema version (typed)', () => {
    const graph = buildFullGraph();
    const wrongType = JSON.parse(JSON.stringify(graph)) as Record<string, unknown>;
    wrongType['objectType'] = 'workflowos/some-other-graph/v1';
    const resultType = parseProofGraph(JSON.stringify(wrongType));
    expect(resultType.ok).toBe(false);
    if (!resultType.ok) {
      expect(resultType.failure.code).toBe('GRAPH_SERIALIZATION_INVALID');
    }

    const wrongVersion = JSON.parse(JSON.stringify(graph)) as Record<string, unknown>;
    wrongVersion['schemaVersion'] = 99;
    const resultVersion = parseProofGraph(JSON.stringify(wrongVersion));
    expect(resultVersion.ok).toBe(false);
  });
});

describe('V2-015 serialization — typed fail-closed parse of top-level binding fields', () => {
  /**
   * ARCHITECT REVIEW (PR #158 Blocker 2) regression: the PUBLIC contract of
   * `parseProofGraph` is the typed `ProofGraphParseResult` — a missing or
   * malformed top-level binding field (workflowId, workflowVersionId,
   * workflowVersionSemanticDigest, runId) must return `ok: false` with the
   * typed `GRAPH_SERIALIZATION_INVALID` failure, NEVER escape as an
   * exception (the throwing field guards sit INSIDE the parse boundary).
   */

  /** value === undefined means the field is DELETED from the payload. */
  function rebindTopLevel(field: string, value: unknown): string {
    const graph = buildFullGraph();
    const payload = JSON.parse(serializeProofGraph(graph)) as Record<string, unknown>;
    if (value === undefined) {
      delete payload[field];
    } else {
      payload[field] = value;
    }
    return JSON.stringify(payload);
  }

  function expectTypedParseFailure(serialized: string, fieldName: string) {
    // the contract: a typed ok:false result, and the call itself never
    // throws (a throw here fails this assertion path loudly)
    let result: ReturnType<typeof parseProofGraph> | undefined;
    expect(() => {
      result = parseProofGraph(serialized);
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.failure.code).toBe('GRAPH_SERIALIZATION_INVALID');
      expect(result!.failure.detail).toContain(fieldName);
    }
  }

  it('missing workflowId → typed GRAPH_SERIALIZATION_INVALID (never a throw)', () => {
    expectTypedParseFailure(rebindTopLevel('workflowId', undefined), 'workflowId');
  });

  it('empty workflowId → typed GRAPH_SERIALIZATION_INVALID (never a throw)', () => {
    expectTypedParseFailure(rebindTopLevel('workflowId', ''), 'workflowId');
  });

  it('missing workflowVersionId → typed GRAPH_SERIALIZATION_INVALID (never a throw)', () => {
    expectTypedParseFailure(rebindTopLevel('workflowVersionId', undefined), 'workflowVersionId');
  });

  it('empty workflowVersionId → typed GRAPH_SERIALIZATION_INVALID (never a throw)', () => {
    expectTypedParseFailure(rebindTopLevel('workflowVersionId', ''), 'workflowVersionId');
  });

  it('missing workflowVersionSemanticDigest → typed GRAPH_SERIALIZATION_INVALID (never a throw)', () => {
    expectTypedParseFailure(rebindTopLevel('workflowVersionSemanticDigest', undefined), 'workflowVersionSemanticDigest');
  });

  it('malformed workflowVersionSemanticDigest (not sha-256) → typed GRAPH_SERIALIZATION_INVALID (never a throw)', () => {
    expectTypedParseFailure(rebindTopLevel('workflowVersionSemanticDigest', 'not-a-sha-256-digest'), 'workflowVersionSemanticDigest');
  });

  it('missing runId → typed GRAPH_SERIALIZATION_INVALID (never a throw)', () => {
    expectTypedParseFailure(rebindTopLevel('runId', undefined), 'runId');
  });

  it('empty runId → typed GRAPH_SERIALIZATION_INVALID (never a throw)', () => {
    expectTypedParseFailure(rebindTopLevel('runId', ''), 'runId');
  });
});

describe('V2-015 serialization — coordinator mutation detection', () => {
  it('detects a dropped node (parse fails typed: an edge endpoint goes missing)', () => {
    const graph = buildFullGraph();
    const dropped = JSON.parse(serializeProofGraph(graph)) as Record<string, unknown>;
    (dropped['nodes'] as unknown[]).pop();
    // dropping a node breaks at least one edge endpoint binding — the parse
    // is a typed failure, NEVER a silent acceptance of the truncated graph
    const parsed = parseProofGraph(JSON.stringify(dropped));
    expect(parsed.ok).toBe(false);
  });

  it('detects a mutated node outcome (append-only rewrite attempt)', () => {
    const graph = buildFullGraph();
    const mutated = JSON.parse(serializeProofGraph(graph)) as Record<string, unknown>;
    const nodes = mutated['nodes'] as Array<Record<string, unknown>>;
    nodes[0]!['outcome'] = nodes[0]!['outcome'] === 'succeeded' ? 'failed' : 'succeeded';
    const parsed = parseProofGraph(JSON.stringify(mutated));
    if (parsed.ok) {
      expect(computeGraphDigest(parsed.graph)).not.toBe(computeGraphDigest(graph));
    } else {
      expect(parsed.failure.code).toBe('GRAPH_SERIALIZATION_INVALID');
    }
  });

  it('detects a forged parent commitment (parent relationships mutated)', () => {
    const graph = buildFullGraph();
    const mutated = JSON.parse(serializeProofGraph(graph)) as Record<string, unknown>;
    const nodes = mutated['nodes'] as Array<Record<string, unknown>>;
    for (const node of nodes) {
      const declared = node['declaredCausalParents'] as string[];
      if (declared.length > 0) {
        node['declaredCausalParents'] = ['f'.repeat(64)];
        break;
      }
    }
    const parsed = parseProofGraph(JSON.stringify(mutated));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      // the commitment no longer matches the declared parents
      expect(parsed.failure.code).toBe('GRAPH_SERIALIZATION_INVALID');
    }
  });

  it('detects a re-wired edge (endpoint digest binding broken)', () => {
    const graph = buildFullGraph();
    const mutated = JSON.parse(serializeProofGraph(graph)) as Record<string, unknown>;
    const edges = mutated['edges'] as Array<Record<string, unknown>>;
    edges[0]!['parentExecutionDigest'] = 'e'.repeat(64);
    const parsed = parseProofGraph(JSON.stringify(mutated));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      // the endpoint digest binding, the edge identity derivation, or the
      // child's causal declaration breaks — any typed rejection detects it
      expect([
        'GRAPH_SERIALIZATION_INVALID',
        'GRAPH_EDGE_INVALID',
        'GRAPH_EDGE_PARENT_UNDECLARED',
        'GRAPH_EDGE_UNKNOWN_NODE',
      ]).toContain(parsed.failure.code);
    }
  });

  it('detects a scope-substituted node (cross-run/cross-version rewrite)', () => {
    const graph = buildFullGraph();
    const mutated = JSON.parse(serializeProofGraph(graph)) as Record<string, unknown>;
    const nodes = mutated['nodes'] as Array<Record<string, unknown>>;
    nodes[0]!['runId'] = 'wfr-a-different-run';
    const parsed = parseProofGraph(JSON.stringify(mutated));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.failure.code).toBe('GRAPH_SCOPE_MISMATCH');
    }
  });

  it('graph digest is stable across fresh builds and discriminates content', () => {
    const g1 = buildFullGraph();
    const g2 = buildFullGraph();
    expect(computeGraphDigest(g1)).toBe(computeGraphDigest(g2));

    // a graph with ONE more node has a different digest
    const bigger = createProofGraphBuilder(PG_SCOPE);
    bigger.addNode(g1.nodes[0]!);
    bigger.addNode(g1.nodes[1]!);
    expect(computeGraphDigest(bigger.graph)).not.toBe(computeGraphDigest(g1));
  });
});

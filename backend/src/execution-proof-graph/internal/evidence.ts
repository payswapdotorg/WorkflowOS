/**
 * V2-015 — internal/evidence composition (the narrow V2-005 adapter).
 *
 * Reconstructs the proof graph from the merged V2-005 public Run/evidence
 * contract (`WorkflowRunHistory` — the Run/RunAttestationBinding records
 * the run boundary persists): the graph is a DETERMINISTIC COMPOSITION over
 * existing evidence, with NO new persistence, NO new Run tables, NO
 * duplicated evidence storage (V2-005 remains the persistence authority;
 * the frozen work order does not require durable graph-specific state).
 *
 *   - the graph scope comes from the RUN record (WorkflowVersion +
 *     semantic digest + Run identity — cross-device continuation preserves
 *     them by construction);
 *   - every durable attestation BINDING becomes one graph node (the
 *     binding carries the attestation identity, execution digest, attester
 *     key, assurance and the canonical statement — everything the node
 *     projection needs; the signature itself stays in V2-014's envelope,
 *     re-verified per-admission);
 *   - causal edges are derived from each statement's declared causalParents
 *     where the parent digest resolves to a bound node of the SAME run
 *     (unresolvable parents are tallied, never invented);
 *   - bindings whose persisted statement does not match the run scope are
 *     rejected typed (fail-closed tallies, never silently merged).
 *
 * TYPE-ONLY consumption of the V2-005 public barrel (data shapes; never a
 * runtime dependency on the run service — pinned by the boundary battery).
 */

import type { WorkflowRunHistory } from '../../workflow-runs/index.js';
import type { ProofGraphFailure, ExecutionProofGraph } from '../types.js';
import { createProofGraphBuilder } from './graph.js';
import { deriveParentCommitment, deriveProofNodeIdentity } from './validation.js';

/** The deterministic result of reconstructing a graph from run history. */
export interface RunHistoryReconstruction {
  readonly graph: ExecutionProofGraph;
  /** Bindings that failed scope/shape validation (typed, fail-closed). */
  readonly rejectedBindings: readonly ProofGraphFailure[];
  /** Declared causal-parent digests with NO bound node in this run's history (tallied, never invented). */
  readonly unresolvedCausalParents: readonly string[];
}

/**
 * Reconstruct the proof graph for one run from its durable history.
 * Deterministic: the same history always reconstructs the same graph
 * (byte-identical serialization); a fresh service instance over the same
 * database reconstructs the same graph (crash-recovery equivalence).
 */
export function reconstructProofGraphFromRunHistory(history: WorkflowRunHistory): RunHistoryReconstruction {
  const run = history.run;
  const builder = createProofGraphBuilder({
    workflowId: run.workflowId,
    workflowVersionId: run.versionId,
    workflowVersionSemanticDigest: run.versionSemanticDigest,
    runId: run.id,
  });

  const rejectedBindings: ProofGraphFailure[] = [];
  const unresolvedCausalParents: string[] = [];

  // 1. every durable binding → one node (deterministic order: the
  //    persistence order of `history.attestations` is the timeline order;
  //    the builder canonicalizes on insert)
  for (const binding of history.attestations) {
    const statement = binding.statement as Record<string, unknown>;
    const node = projectBindingToNode(binding, statement);
    if (!node.ok) {
      rejectedBindings.push(node.failure);
      continue;
    }
    const result = builder.addNode(node.node);
    if (result.kind === 'rejected') {
      rejectedBindings.push(result.failure);
    }
  }

  // 2. causal edges from each statement's declared parents (resolved
  //    through the reconstructed node set — never invented)
  const nodesByDigest = new Map<string, { executionDigest: string; attestationId: string }>();
  for (const node of builder.graph.nodes) {
    nodesByDigest.set(node.executionDigest, node);
  }
  for (const binding of history.attestations) {
    const child = nodesByDigest.get(binding.executionDigest);
    if (!child) {
      continue; // the binding was rejected above
    }
    const statement = binding.statement as Record<string, unknown>;
    const causalParents = Array.isArray(statement['causalParents']) ? (statement['causalParents'] as unknown[]) : [];
    for (const parentDigest of causalParents) {
      if (typeof parentDigest !== 'string') {
        continue;
      }
      const parent = nodesByDigest.get(parentDigest);
      if (!parent) {
        unresolvedCausalParents.push(parentDigest);
        continue;
      }
      builder.addCausalEdge({
        parentAttestationId: parent.attestationId,
        childAttestationId: child.attestationId,
      });
    }
  }

  return {
    graph: builder.graph,
    rejectedBindings,
    unresolvedCausalParents,
  };
}

// ============================================================================
// Binding → node projection (pure)
// ============================================================================

function projectBindingToNode(
  binding: {
    readonly attestationId: string;
    readonly executionDigest: string;
    readonly attesterKeyId: string;
    readonly assurance: string;
    readonly runId: string;
    readonly attemptNumber: number;
    readonly stepId: string | null;
  },
  statement: Record<string, unknown>,
): { ok: true; node: import('../types.js').ExecutionProofNode } | { ok: false; failure: ProofGraphFailure } {
  const causalParents = Array.isArray(statement['causalParents'])
    ? (statement['causalParents'] as readonly unknown[]).filter((d): d is string => typeof d === 'string')
    : [];
  const declared = [...causalParents].sort();

  const workflowId = statement['workflowId'];
  const workflowVersionId = statement['workflowVersionId'];
  const workflowVersionSemanticDigest = statement['workflowVersionSemanticDigest'];
  const statementRunId = statement['runId'];
  const attemptId = statement['attemptId'];
  const executorNodeId = statement['nodeId'];
  const outcome = statement['outcome'];

  if (
    typeof workflowId !== 'string' ||
    typeof workflowVersionId !== 'string' ||
    typeof workflowVersionSemanticDigest !== 'string' ||
    typeof statementRunId !== 'string' ||
    typeof executorNodeId !== 'string' ||
    typeof attemptId !== 'number' ||
    (outcome !== 'succeeded' && outcome !== 'failed')
  ) {
    return {
      ok: false,
      failure: {
        code: 'GRAPH_NODE_INVALID',
        detail: 'the persisted binding statement is missing required binding fields',
        identity: binding.attestationId,
      },
    };
  }

  if (statementRunId !== binding.runId) {
    return {
      ok: false,
      failure: {
        code: 'GRAPH_SCOPE_MISMATCH',
        detail: `the binding statement's runId (${statementRunId}) does not match the binding row (${binding.runId})`,
        identity: binding.attestationId,
      },
    };
  }

  return {
    ok: true,
    node: {
      nodeIdentity: deriveProofNodeIdentity(binding.attestationId),
      attestationId: binding.attestationId,
      executionDigest: binding.executionDigest,
      attesterKeyId: binding.attesterKeyId,
      assurance: binding.assurance as import('../types.js').ExecutionProofNode['assurance'],
      outcome,
      workflowId,
      workflowVersionId,
      workflowVersionSemanticDigest,
      runId: binding.runId,
      attemptId: typeof attemptId === 'number' ? attemptId : binding.attemptNumber,
      stepId: binding.stepId,
      executorNodeId,
      declaredCausalParents: declared,
      parentCommitment: deriveParentCommitment(declared),
    },
  };
}

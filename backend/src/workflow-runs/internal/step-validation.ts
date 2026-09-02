/**
 * V2-005 — step-declaration validation against the pinned WorkflowVersion's
 * DECLARED step semantics (PURE). The pinned version's content is read
 * through the merged V2-002 repository (opaque) and parsed with the merged
 * V2-003 barrel (the semantic authority) — this module never re-implements
 * IR semantics, it consumes the merged parse + node declarations.
 */
import { WorkflowRunError } from '../types.js';
import type { RunExecutionClass } from '../types.js';
import type { WorkflowIrDocument } from '../../workflow-ir/index.js';

/**
 * The declared step (node) ids of the pinned version, in deterministic
 * FLOW order: the declared start node first, then a depth-first traversal
 * of the declared control edges in document order.
 *
 * Rationale (recorded decision): the merged V2-003 canonical serialization
 * stores `ir.nodes` in CANONICAL (sorted) order — the authoring declaration
 * order is not recoverable from the serialized document. The deterministic
 * order this module can honestly derive is the flow order from the declared
 * start node (the same order a reconstructed execution history presents its
 * steps in). Nodes unreachable from the start (V2-003 validation rejects
 * such documents; kept defensively) are appended in canonical node order.
 */
export function declaredStepIdsOf(document: WorkflowIrDocument): string[] {
  const ids = document.ir.nodes.map((node) => node.id);
  const order: string[] = [];
  const visited = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of document.ir.edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    visited.add(stepId);
    order.push(stepId);
    for (const next of adjacency.get(stepId) ?? []) {
      visit(next);
    }
  };
  visit(document.ir.start);
  for (const id of ids) {
    if (!visited.has(id)) {
      visited.add(id);
      order.push(id);
    }
  }
  return order;
}

/**
 * Validate that `stepId` is a step the pinned version DECLARES. The declared
 * execution class of the step is surfaced (invocation records carry canonical
 * classes; the step's own declaration is the reference).
 */
export function validateRunStepDeclaration(
  document: WorkflowIrDocument,
  stepId: string,
): { ok: true; executionClass: RunExecutionClass } | { ok: false; code: 'RUN_STEP_NOT_DECLARED' } {
  const node = document.ir.nodes.find((candidate) => candidate.id === stepId);
  if (node === undefined) {
    return { ok: false, code: 'RUN_STEP_NOT_DECLARED' };
  }
  return { ok: true, executionClass: node.executionClass };
}

/** Throwing variant (typed; never bare). */
export function assertRunStepDeclaration(document: WorkflowIrDocument, stepId: string): RunExecutionClass {
  const check = validateRunStepDeclaration(document, stepId);
  if (!check.ok) {
    throw new WorkflowRunError(
      'RUN_STEP_NOT_DECLARED',
      `step "${stepId}" is not declared by the run's pinned WorkflowVersion — steps reference the version's declared step semantics (declared: ${declaredStepIdsOf(document).join(', ')})`,
    );
  }
  return check.executionClass;
}

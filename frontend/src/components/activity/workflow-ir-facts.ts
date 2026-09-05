/**
 * workflow-ir-facts — the shared read-only WorkflowIR fact extractors
 * (V2-017). ONE source for the approval-node facts both the run-status
 * surface (T6) and the Activity timeline (T10) derive: the CONSENT boundary
 * is declared by the IR's human nodes (spec.human.kind === 'approval') —
 * never guessed from node ids, never fabricated. Internal node ids are
 * handled only as set membership keys (never rendered — F-T4-001).
 */

/** The IR's approval-node step ids (the CONSENT boundary facts). */
export function approvalStepIdsFromContent(content: unknown): ReadonlySet<string> {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return new Set();
  }
  const doc = content as { objectType?: unknown; ir?: { nodes?: unknown } | null };
  if (doc.objectType !== 'workflowos/workflow-ir/v1') return new Set();
  if (!doc.ir || !Array.isArray(doc.ir.nodes)) return new Set();
  const ids = new Set<string>();
  for (const node of doc.ir.nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const spec = (node as { spec?: unknown }).spec;
    const { id } = node as { id?: unknown };
    if (typeof id !== 'string') continue;
    if (typeof spec !== 'object' || spec === null) continue;
    const human = (spec as { human?: unknown }).human;
    if (
      typeof human === 'object' &&
      human !== null &&
      (human as { kind?: unknown }).kind === 'approval'
    ) {
      ids.add(id);
    }
  }
  return ids;
}

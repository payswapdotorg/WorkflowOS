/**
 * workflow-ir-facts — the shared read-only WorkflowIR fact extractors
 * (V2-017). ONE source for the approval-node facts the run-status surface
 * (T6), the Activity timeline (T10), and Home's Pending approvals
 * (REALITY-REPAIR-005) derive: the CONSENT boundary is declared by the
 * IR's human nodes (spec.human.kind === 'approval') — never guessed from
 * node ids, never fabricated. Internal node ids are handled only as set
 * membership keys (never rendered — F-T4-001).
 */

import type { ProductRunTimelineEntry } from '../../api/client';

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

/**
 * The approval-waiting derivation (REALITY-REPAIR-005 extraction — ONE
 * source for the fact previously derived inline by the RunExperience
 * status surface and the Activity timeline's Needs-me bucket): does the
 * history's LAST workflow.run.paused entry ride an IR approval node of the
 * given version content?
 *
 * The authoritative wire shape is consumed exactly as the run-status
 * surface established it: the pause entry's detail.atStepId carries the
 * executor-reported pause point (never guessed; the entry's own stepId is
 * the fallback), and the approval boundary comes from
 * approvalStepIdsFromContent. No evidence — no pause entry, no approval
 * node declared, no readable content — means NO claim: the answer is
 * false, never a guess.
 */
export function lastPauseAtApprovalStep(
  timeline: readonly ProductRunTimelineEntry[],
  content: unknown,
): boolean {
  const pauses = timeline
    .filter((entry) => entry.eventName === 'workflow.run.paused')
    .sort((a, b) => a.sequence - b.sequence);
  const last = pauses[pauses.length - 1];
  const atStepId =
    (last?.detail && typeof last.detail.atStepId === 'string'
      ? (last.detail.atStepId as string)
      : null) ?? last?.stepId ?? null;
  if (atStepId === null) return false;
  return approvalStepIdsFromContent(content).has(atStepId);
}

/**
 * V2-017 T11 - the versions/updates/improvements vocabulary (Issue #202).
 *
 * PURE presentation functions over the V2-011/V2-002 transport wire
 * shapes. This module NEVER re-derives analysis, comparisons, proposals
 * or version facts - it renders the authority's own facts in consumer
 * language (UX 19/20 + 29: "Optimization proposal -> Improvement",
 * "Maintenance update -> Update available"). Internal node IDs never
 * render (the V2-003 presentation labels are the step names - F-T4-001);
 * the modeled rubric deltas are presented as ESTIMATES, never
 * measurements (UX 20: "each proposal explains what trade-offs exist").
 */

import type {
  ProductVersionComparison,
  ProductCriterionDelta,
} from '../../api/client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IR_OBJECT_TYPE = 'workflowos/workflow-ir/v1';

/** The nodeLabels map from the authoritative V2-003 presentation layer. */
export function nodeLabelsFromContent(content: unknown): Record<string, string> | null {
  if (!isRecord(content)) return null;
  const objectType = content.objectType;
  if (typeof objectType !== 'string' || objectType !== IR_OBJECT_TYPE) return null;
  const presentation = content.presentation;
  if (!isRecord(presentation)) return null;
  const nodeLabels = presentation.nodeLabels;
  if (!isRecord(nodeLabels)) return null;
  const labels: Record<string, string> = {};
  for (const [id, label] of Object.entries(nodeLabels)) {
    if (typeof label === 'string' && label.trim() !== '') labels[id] = label;
  }
  return labels;
}

/** The consumer step name for a node id (fail-closed to null - F-T4-001). */
export function stepLabel(labels: Record<string, string> | null, nodeId: string): string | null {
  const label = labels?.[nodeId];
  return typeof label === 'string' && label.trim() !== '' ? label : null;
}

/** The 20-recommendation headline for one opportunity kind. */
export function improvementHeadline(kind: string): string {
  if (kind === 'api_substitution') return 'Make it more reliable and faster';
  if (kind === 'workflow_reuse') return 'Reuse the duplicated steps';
  return 'Improvement';
}

/** The 20-recommendation detail for one opportunity (declared facts only). */
export function improvementDetail(opportunity: {
  kind: string;
  apiCapability?: string;
}): string {
  if (opportunity.kind === 'api_substitution' && opportunity.apiCapability) {
    return `Replace the agent-driven step with the direct ${opportunity.apiCapability} API call.`;
  }
  return 'Reference one shared version instead of duplicating the steps.';
}

/** The correctness verdict line (19/20 - correctness FIRST, verbatim honest). */
export function correctnessLine(comparison: ProductVersionComparison): string {
  if (comparison.correctness?.equivalent) {
    return 'Task-for-task equivalent - verified';
  }
  const divergence = comparison.correctness?.firstDivergence;
  return divergence ? `Not equivalent: ${divergence}` : 'Not equivalent';
}

/** The compatibility line from the V2-003 negotiation decision. */
export function compatibilityLine(comparison: ProductVersionComparison): string {
  const decision = comparison.negotiation?.decision;
  if (decision === 'accept') return 'No change to what the workflow does';
  if (decision === 'upgrade') return 'Adds behavior without changing what it does';
  if (decision === 'reject') return 'Incompatible change - rejected';
  return 'Compatibility not classified';
}

function scoreLine(name: string, delta: ProductCriterionDelta | undefined): string | null {
  if (!delta || typeof delta.baseline !== 'number' || typeof delta.candidate !== 'number') {
    return null;
  }
  return `${name} score ${delta.baseline} to ${delta.candidate}`;
}

/**
 * The trade-off lines from the modeled rubric (20: "what trade-offs
 * exist"). Lower is better for every criterion; a WORSE candidate score
 * renders verbatim (the honest trade-off - reliability can honestly
 * worsen for reuse).
 */
export function tradeOffLines(comparison: ProductVersionComparison): string[] {
  const lines: string[] = [];
  const push = (line: string | null) => {
    if (line) lines.push(line);
  };
  push(scoreLine('Speed', comparison.latency));
  push(scoreLine('Cost', comparison.cost));
  push(scoreLine('Reliability', comparison.reliability));
  push(scoreLine('Maintenance', comparison.maintenance));
  return lines;
}

/** The single honest estimates note (modeled rubric - never measurements). */
export const ESTIMATES_NOTE =
  'Lower scores are better - these are modeled estimates, not measurements.';

/** The proposal status word (20: the approval gate state). */
export function proposalStatusWord(status: string): string {
  if (status === 'proposed') return 'Proposed';
  if (status === 'approved') return 'Approved - not created yet';
  if (status === 'rejected') return 'Rejected';
  if (status === 'materialized') return 'Created as a new version';
  return status;
}

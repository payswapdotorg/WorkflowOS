/**
 * V2-012 — the maintenance-update compatibility rule (V2-003's authority,
 * consumed).
 *
 * "A maintenance update may be accepted only when compatibility rules pass"
 * (workflow-marketplace-economics.md). The compatibility rules ARE V2-003's
 * version-update negotiation — consumed through the merged barrel and NEVER
 * re-implemented here: the pinned (subscribed/purchased) version and the
 * candidate update are both parsed as real WorkflowIR documents, their
 * public-surface snapshots are handed to `negotiateWorkflowVersionUpdate`,
 * and the decision ('accept' | 'upgrade') is what grants maintenance
 * access. A 'reject' (breaking change or inconsistent declaration) requires
 * an explicit customer transition — never a silent maintenance update.
 */
import {
  parseWorkflowIrDocument,
  negotiateWorkflowVersionUpdate,
} from '../../workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowSurfaceSnapshot } from '../../workflow-ir/index.js';
import type { MarketplaceVersionFacts } from '../types.js';

/** The public-surface snapshot of one real WorkflowIR document (V2-003's shape). */
export function surfaceSnapshotOf(document: WorkflowIrDocument): WorkflowSurfaceSnapshot {
  return {
    inputs: document.ir.inputs,
    outputs: document.ir.outputs,
    compatibility: document.compatibility,
  };
}

/** Parse a stored version's opaque content as a real WorkflowIR document. */
export function parseVersionDocument(
  version: MarketplaceVersionFacts,
): WorkflowIrDocument | undefined {
  const parsed = parseWorkflowIrDocument(JSON.stringify(version.content));
  return parsed.ok ? parsed.document : undefined;
}

/**
 * Is the candidate a COMPATIBLE maintenance update of the pinned baseline?
 * Fail-closed: any parse failure or a V2-003 'reject' decision answers NO.
 */
export function isCompatibleUpdate(
  baseline: WorkflowIrDocument,
  candidate: WorkflowIrDocument,
): boolean {
  const decision = negotiateWorkflowVersionUpdate({
    installed: surfaceSnapshotOf(baseline),
    candidate: surfaceSnapshotOf(candidate),
  });
  return decision.decision === 'accept' || decision.decision === 'upgrade';
}

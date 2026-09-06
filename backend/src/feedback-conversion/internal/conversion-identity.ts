/**
 * WORK-068 — the deterministic proposal identity (no randomness).
 *
 * The proposal identity is the DEDUP KEY of the conversion layer:
 * `FB-<10 hex>` — sha256 over the canonical proposal scope
 * (organizationId | projectId | architectureVersionId | logicalFailureKey).
 *
 * This mirrors the WORK-040 `computeProposedWorkItemId` discipline: the
 * deterministic id + the existing UNIQUE(architecture_version_id,
 * work_item_id) DB constraint together fence concurrent conversion runs —
 * the same logical failure in the same target version converges on ONE
 * Work Item, never a second one.
 *
 * The scope dimensions are REQUIRED (fail-closed): a missing organization,
 * project, architecture version, or logical failure key is a typed
 * rejection — an identity without its full scope would silently merge
 * foreign work (the cross-tenant / cross-project discrimination).
 */
import { createHash } from 'node:crypto';
import { FeedbackConversionError } from '../types.js';

/** The proposal id prefix (the human-readable origin marker, WORK-040's `PLAN-` convention). */
export const PROPOSAL_ID_PREFIX = 'FB-';

/** The canonical serialization of the identity scope (the sha256 preimage). */
function canonicalScope(input: {
  organizationId: string;
  projectId: string;
  architectureVersionId: string;
  logicalFailureKey: string;
}): string {
  return [
    input.organizationId,
    input.projectId,
    input.architectureVersionId,
    input.logicalFailureKey,
  ].join('|');
}

/**
 * Derive the deterministic proposal identity. Pure: identical scope →
 * byte-identical identity. Fail-closed: any empty scope dimension is
 * rejected (the dimension is load-bearing — the discrimination tests
 * prove each one).
 */
export function deriveProposalIdentity(input: {
  organizationId: string;
  projectId: string;
  architectureVersionId: string;
  logicalFailureKey: string;
}): { proposalId: string; identityFingerprint: string } {
  if (!input.organizationId) {
    throw new FeedbackConversionError(
      'CONVERSION_ORGANIZATION_REQUIRED',
      'the proposal identity requires the organization scope (a missing organization would silently merge foreign work)',
    );
  }
  if (!input.projectId) {
    throw new FeedbackConversionError(
      'CONVERSION_PROJECT_REQUIRED',
      'the proposal identity requires the project scope (a missing project would silently merge foreign work)',
    );
  }
  if (!input.architectureVersionId) {
    throw new FeedbackConversionError(
      'CONVERSION_ARCHITECTURE_VERSION_REQUIRED',
      'the proposal identity requires the target architecture version (the Work Item traceability chain)',
    );
  }
  if (!input.logicalFailureKey) {
    throw new FeedbackConversionError(
      'CONVERSION_LOGICAL_KEY_REQUIRED',
      'the proposal identity requires the logical failure key (the dedup dimension — a free-floating proposal is impossible)',
    );
  }
  const fingerprint = createHash('sha256')
    .update(canonicalScope(input), 'utf8')
    .digest('hex');
  return {
    proposalId: `${PROPOSAL_ID_PREFIX}${fingerprint.slice(0, 10)}`,
    identityFingerprint: fingerprint,
  };
}

/**
 * The deterministic proposal ordering for the backlog-relative priority:
 * by (priority score DESC, logicalFailureKey ASC) — stable, total,
 * never wall-clock.
 */
export function compareProposals(
  a: { priority: 'high' | 'medium' | 'low'; logicalFailureKey: string },
  b: { priority: 'high' | 'medium' | 'low'; logicalFailureKey: string },
): number {
  const order: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 };
  const byPriority = order[b.priority] - order[a.priority];
  if (byPriority !== 0) return byPriority;
  return a.logicalFailureKey < b.logicalFailureKey ? -1 : a.logicalFailureKey > b.logicalFailureKey ? 1 : 0;
}

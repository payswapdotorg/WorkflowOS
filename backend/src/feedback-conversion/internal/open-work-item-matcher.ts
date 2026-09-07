/**
 * WORK-068 — the deduplication boundary: matching a conversion proposal
 * against the EXISTING OPEN Work Items of the target architecture version.
 *
 * The Work Order's contract: "a signal that duplicates an existing open
 * Work Item is deduplicated, not converted into a second Work Item." The
 * matcher therefore considers ONLY OPEN items (`completed === false`):
 *
 *   - a COMPLETED Work Item does not block a new conversion — a recurring
 *     logical failure after the fix merged is NEW governed work, recorded
 *     with recurrence provenance (`recurrenceOf`);
 *   - an OPEN match on the deterministic proposal id (the same FB- id in
 *     the same architecture version) → 'open-proposal-id-match';
 *   - an OPEN match on recorded signal provenance (an open Work Item whose
 *     `metadata.feedbackConversion.sourceSignalIds` already carries one of
 *     the proposal's originating signal ids) → 'open-signal-provenance-match'
 *     (a signal never converts twice);
 *   - both matches CONVERGE: the proposal is deduplicated, never
 *     duplicated. The persistence-level fence stays the existing
 *     UNIQUE(architecture_version_id, work_item_id) DB constraint (the
 *     WORK-040 model — this matcher is the application-level pre-check,
 *     never the only guarantee).
 *
 * The match keys are read from the AUTHORITATIVE Work Item records — this
 * domain owns no parallel store.
 */
import type { WorkItem } from '@modules/work-items/index.js';
import type { ProposalDedupOutcome } from '../types.js';

/** The metadata field name this domain reads/writes (the single convention). */
export const FEEDBACK_CONVERSION_METADATA_FIELD = 'feedbackConversion';

/**
 * The honest accessor for the Work Item's conversion metadata (typed,
 * fail-closed on shape): null when absent or malformed — never a fabricated
 * payload (a failed read is distinguishable from a genuine absence).
 */
export function readConversionMetadata(
  workItem: WorkItem,
): ReadonlyArray<string> | null {
  const metadata = workItem.metadata as Record<string, unknown> | null;
  if (!metadata || typeof metadata !== 'object') return null;
  const payload = metadata[FEEDBACK_CONVERSION_METADATA_FIELD] as
    | { sourceSignalIds?: unknown }
    | null
    | undefined;
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.sourceSignalIds)) return null;
  const ids = payload.sourceSignalIds.filter((id): id is string => typeof id === 'string');
  return ids.length === payload.sourceSignalIds.length ? ids : null;
}

/**
 * The proposal id FAMILY: the base deterministic id (`FB-<10 hex>`) and its
 * recurrence generations (`FB-<10 hex>.R2`, `.R3`, …). A completed item of
 * the same family does NOT block a recurring conversion — the recurrence
 * is new governed work with a distinct id (the existing
 * UNIQUE(architecture_version_id, work_item_id) constraint stays intact).
 */
export function isSameProposalFamily(workItemId: string, baseProposalId: string): boolean {
  if (workItemId === baseProposalId) return true;
  return workItemId.startsWith(`${baseProposalId}.R`);
}

/**
 * Match a proposal (by its deterministic proposal id + originating signal
 * ids) against the target version's Work Items. Returns the dedup outcome,
 * the matched OPEN Work Item ids, and the recurrence chain (COMPLETED
 * items of the same proposal family — the logical failure was converted
 * before and the fix merged; the recurrence is new governed work).
 *
 * PURE + deterministic: identical inputs → identical outcome.
 */
export function matchOpenWorkItems(input: {
  proposalId: string;
  sourceSignalIds: readonly string[];
  workItems: readonly WorkItem[];
}): {
  outcome: ProposalDedupOutcome;
  matchedOpenWorkItemIds: readonly string[];
  recurrenceOf: readonly string[];
} {
  const openItems = input.workItems.filter((item) => item.completed === false);
  const matchedOpen: string[] = [];
  let provenanceMatch = false;
  for (const item of openItems) {
    const idMatch = isSameProposalFamily(item.workItemId, input.proposalId);
    const signalIds = readConversionMetadata(item);
    const provenance = signalIds !== null
      && input.sourceSignalIds.some((signalId) => signalIds.includes(signalId));
    if (idMatch || provenance) {
      matchedOpen.push(item.id);
      if (provenance) provenanceMatch = true;
    }
  }
  // The recurrence chain: COMPLETED items of the same proposal family.
  const recurrenceOf = input.workItems
    .filter((item) => item.completed === true && isSameProposalFamily(item.workItemId, input.proposalId))
    .map((item) => item.id);

  const outcome: ProposalDedupOutcome = matchedOpen.length === 0
    ? 'no-open-match'
    : provenanceMatch
      ? 'open-signal-provenance-match'
      : 'open-proposal-id-match';
  return {
    outcome,
    matchedOpenWorkItemIds: matchedOpen,
    recurrenceOf,
  };
}

/**
 * Derive the CREATION id for a recurrence: the base id when the family is
 * empty in this version; the next generation (`FB-<10 hex>.R2`, `.R3`, …)
 * when completed family members exist (the existing UNIQUE constraint
 * stays intact — the recurrence is a DISTINCT Work Item).
 */
export function deriveCreationId(input: {
  proposalId: string;
  recurrenceOf: readonly string[];
  workItems: readonly WorkItem[];
}): { creationId: string; generation: number } {
  if (input.recurrenceOf.length === 0) {
    return { creationId: input.proposalId, generation: 1 };
  }
  // The generation = the count of existing family items + 1 (deterministic
  // given the repository state; the DB constraint fences the race).
  const familyCount = input.workItems.filter(
    (item) => isSameProposalFamily(item.workItemId, input.proposalId),
  ).length;
  const generation = familyCount + 1;
  return { creationId: `${input.proposalId}.R${generation}`, generation };
}

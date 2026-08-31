/**
 * WORK-067 — the release correlation engine.
 *
 * Correlates an Engineering Signal to RECORDED release context(s). The
 * release identity NEVER originates here: every release reference + boundary
 * time arrives through the caller-supplied {@link ReleaseCorrelationContext}
 * (the honest boundary while NO release authority exists in the repository
 * — the ONLY recorded release references today are the WORK-064
 * POST_RELEASE `releaseRef` records; the future release authority binds at
 * the same input).
 *
 * THE CAUSAL DISCIPLINE (the wrong-release discrimination):
 *
 *   1. The signal's occurrences record their causal release bindings
 *      (occurrence.releaseRef — the source-recorded references). The set of
 *      DISTINCT non-null bindings is the signal's CAUSAL CHAIN.
 *   2. A release context whose reference IS in the causal chain →
 *      CORRELATED, basis `provenance-release-ref` (VERIFIED against the
 *      occurrence provenance — the strongest basis).
 *   3. A release context whose reference is NOT in the causal chain while
 *      the signal HAS a causal chain → NOT correlated, basis
 *      `causal-binding-mismatch` (a signal causally bound to release A is
 *      never blindly correlated to release B — no matter the timestamps).
 *   4. A signal with NO causal bindings (PRE_MERGE/CONTINUOUS validation
 *      observations, CI rows, runtime observations — no recorded release
 *      reference) may correlate via the CALLER-DECLARED basis ONLY when at
 *      least one observation overlaps the release's post-release window
 *      (observedAt >= releasedAt): basis `caller-declared` (the weaker,
 *      explicitly-recorded basis). No time overlap → basis
 *      `no-time-overlap` (not correlated).
 *
 *   5. A context whose project scope differs from the signal's → the typed
 *      SIGNAL_RELEASE_PROJECT_MISMATCH rejection (fail-closed).
 *
 * PURE + DETERMINISTIC: no clock, no randomness — the output is a pure
 * function of (the signal's occurrences, the supplied contexts).
 */
import { EngineeringSignalError } from '../types.js';
import type {
  EngineeringSignal,
  ReleaseCorrelationContext,
  ReleaseCorrelationEntry,
} from '../types.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Validate a release correlation context (fail-closed; RECORDED identity only). */
export function requireValidReleaseContext(context: ReleaseCorrelationContext): ReleaseCorrelationContext {
  if (context === null || typeof context !== 'object') {
    throw new EngineeringSignalError('SIGNAL_RELEASE_CONTEXT_INVALID', 'a release correlation context is required');
  }
  if (typeof context.releaseRef !== 'string' || context.releaseRef.trim() === '') {
    throw new EngineeringSignalError(
      'SIGNAL_RELEASE_REF_REQUIRED',
      'a release correlation context requires a non-empty recorded releaseRef (WORK-067 never invents a release identity)',
    );
  }
  if (typeof context.releasedAt !== 'string' || !ISO_TIMESTAMP.test(context.releasedAt) || Number.isNaN(Date.parse(context.releasedAt))) {
    throw new EngineeringSignalError(
      'SIGNAL_RELEASED_AT_INVALID',
      `the release boundary '${String(context.releasedAt)}' must be a recorded ISO-8601 timestamp`,
    );
  }
  if (context.recordedVia !== 'validation-run-release-ref' && context.recordedVia !== 'caller-declared') {
    throw new EngineeringSignalError(
      'SIGNAL_RELEASE_CONTEXT_INVALID',
      `the release identity provenance '${String(context.recordedVia)}' must be 'validation-run-release-ref' or 'caller-declared' (recorded, never inferred)`,
    );
  }
  if (typeof context.projectId !== 'string' || context.projectId.trim() === '') {
    throw new EngineeringSignalError('SIGNAL_RELEASE_CONTEXT_INVALID', 'a release correlation context requires a non-empty project scope');
  }
  return context;
}

/**
 * The causal release bindings recorded on the signal's occurrences (the
 * DISTINCT non-null occurrence releaseRefs — the signal's causal chain).
 */
export function recordedCausalBindings(signal: EngineeringSignal): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const occurrence of signal.occurrences) {
    if (occurrence.releaseRef !== null && occurrence.releaseRef !== '') {
      bindings.add(occurrence.releaseRef);
    }
  }
  return bindings;
}

/** Whether at least one observation overlaps the release's post-release window (observedAt >= releasedAt). */
function overlapsPostReleaseWindow(signal: EngineeringSignal, releasedAt: string): boolean {
  const boundary = Date.parse(releasedAt);
  for (const occurrence of signal.occurrences) {
    if (Date.parse(occurrence.observedAt) >= boundary) return true;
  }
  return false;
}

/**
 * Correlate a signal to the supplied release context(s). PURE and
 * deterministic; every decision is an explicit {@link ReleaseCorrelationEntry}
 * with its causal basis and reason (never silent). Project-scope mismatches
 * throw the typed rejection (fail-closed at the boundary).
 */
export function correlateSignalToReleases(
  signal: EngineeringSignal,
  contexts: readonly ReleaseCorrelationContext[],
): readonly ReleaseCorrelationEntry[] {
  const validated = contexts.map(requireValidReleaseContext);
  const causalBindings = recordedCausalBindings(signal);
  const entries: ReleaseCorrelationEntry[] = [];
  for (const context of validated) {
    if (context.projectId !== signal.projectId) {
      throw new EngineeringSignalError(
        'SIGNAL_RELEASE_PROJECT_MISMATCH',
        `the release context '${context.releaseRef}' belongs to project '${context.projectId}' but the signal '${signal.signalId}' belongs to project '${signal.projectId}' (release correlation is project-scoped)`,
      );
    }
    if (causalBindings.size > 0) {
      if (causalBindings.has(context.releaseRef)) {
        entries.push({
          releaseRef: context.releaseRef,
          releasedAt: context.releasedAt,
          projectId: context.projectId,
          correlated: true,
          causalBasis: 'provenance-release-ref',
          reason: `the signal's occurrences record the causal release reference '${context.releaseRef}' (verified against the occurrence provenance; boundary ${context.releasedAt}; identity established ${context.recordedVia})`,
        });
      } else {
        entries.push({
          releaseRef: context.releaseRef,
          releasedAt: context.releasedAt,
          projectId: context.projectId,
          correlated: false,
          causalBasis: 'causal-binding-mismatch',
          reason: `the signal's causal chain binds to release(s) ${[...causalBindings].map((r) => `'${r}'`).join(', ')} — correlating to release '${context.releaseRef}' is REJECTED (a signal causally bound to another release is never blindly correlated by time alone)`,
        });
      }
    } else if (overlapsPostReleaseWindow(signal, context.releasedAt)) {
      entries.push({
        releaseRef: context.releaseRef,
        releasedAt: context.releasedAt,
        projectId: context.projectId,
        correlated: true,
        causalBasis: 'caller-declared',
        reason: `the signal has NO recorded causal release binding; the caller declared the association with release '${context.releaseRef}' (recorded verbatim, the weaker basis) and at least one observation overlaps the post-release window (boundary ${context.releasedAt}; identity established ${context.recordedVia})`,
      });
    } else {
      entries.push({
        releaseRef: context.releaseRef,
        releasedAt: context.releasedAt,
        projectId: context.projectId,
        correlated: false,
        causalBasis: 'no-time-overlap',
        reason: `the signal has NO recorded causal release binding and NO observation overlaps the post-release window of release '${context.releaseRef}' (boundary ${context.releasedAt}) — not correlated`,
      });
    }
  }
  return entries;
}

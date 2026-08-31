/**
 * WORK-067 — the regression assessment engine (ADVISORY).
 *
 * Assesses the likely-regression status of an Engineering Signal per
 * CORRELATED release, from the signal's occurrence timeline. The Work
 * Order's regression contract:
 *
 *   - a signal PRESENT AFTER a release and ABSENT BEFORE it → a LIKELY
 *     REGRESSION (the release is the candidate cause);
 *   - a signal present before AND after → NOT a regression merely because
 *     a release happened (the failure pre-dates the release);
 *   - a signal whose severity INCREASED across the release boundary →
 *     regression-relevant (likely regression);
 *   - a severity DECREASE is never promoted;
 *   - the boundary split is deterministic: before = observedAt < releasedAt,
 *     after = observedAt >= releasedAt (the release is live from its
 *     boundary — no fuzzy wall-clock behavior);
 *   - the severity at the boundary uses the observations IMMEDIATELY
 *     adjacent to it (the LAST pre-release occurrence, the FIRST
 *     post-release occurrence) under the deterministic (observedAt,
 *     recordedAt, occurrenceId) ordering;
 *   - NO release correlation (no contexts, or every context rejected) →
 *     the assessment is explicitly `unavailable` with likelyRegression
 *     NULL — never a false `false` (a failure signal never becomes
 *     silently healthy).
 *
 * PURE + DETERMINISTIC + ADVISORY: the output is a pure function of (the
 * signal's occurrences, the correlation entries); it mutates nothing.
 */
import type {
  EngineeringSignal,
  ReleaseCorrelationEntry,
  ReleaseRegressionAssessment,
  RegressionAssessment,
  SignalOccurrence,
  SignalSeverity,
} from '../types.js';
import { SEVERITY_ORDER } from '../types.js';
import { compareOccurrences } from './signal-identity.js';

/** The sorted occurrence view (the deterministic timeline). */
function sortedOccurrences(occurrences: readonly SignalOccurrence[]): SignalOccurrence[] {
  return [...occurrences].sort(compareOccurrences);
}

/** The per-release assessment for one CORRELATED release entry. */
function assessForRelease(
  signal: EngineeringSignal,
  entry: ReleaseCorrelationEntry,
): ReleaseRegressionAssessment {
  const timeline = sortedOccurrences(signal.occurrences);
  const boundary = Date.parse(entry.releasedAt);
  const before = timeline.filter((o) => Date.parse(o.observedAt) < boundary);
  const after = timeline.filter((o) => Date.parse(o.observedAt) >= boundary);
  const beforeIds = before.map((o) => o.occurrenceId);
  const afterIds = after.map((o) => o.occurrenceId);

  // The severity immediately adjacent to the boundary (deterministic).
  const severityBefore: SignalSeverity | null = before.length > 0 ? before[before.length - 1]!.severity : null;
  const severityAfter: SignalSeverity | null = after.length > 0 ? after[0]!.severity : null;

  if (before.length === 0 && after.length === 0) {
    // Defensive: a correlated signal always has ≥1 occurrence, but the
    // boundary could exclude all of them in a malformed future; honest
    // non-assessment, never a fabricated verdict.
    return {
      releaseRef: entry.releaseRef,
      releasedAt: entry.releasedAt,
      outcome: 'not_assessable',
      reason: `no observation of the signal falls on either side of the release '${entry.releaseRef}' boundary ${entry.releasedAt} — not assessable`,
      beforeOccurrenceIds: beforeIds,
      afterOccurrenceIds: afterIds,
      severityBefore: null,
      severityAfter: null,
      severityChange: 'unavailable',
    };
  }

  const presentBefore = before.length > 0;
  const presentAfter = after.length > 0;

  if (!presentBefore && presentAfter) {
    // THE POSITIVE REGRESSION: absent before, present after.
    return {
      releaseRef: entry.releaseRef,
      releasedAt: entry.releasedAt,
      outcome: 'likely_regression',
      reason: `the signal was ABSENT before release '${entry.releaseRef}' (boundary ${entry.releasedAt}: 0 occurrences before) and PRESENT after (${after.length} occurrence(s) at/after the boundary) — a likely regression (advisory)`,
      beforeOccurrenceIds: beforeIds,
      afterOccurrenceIds: afterIds,
      severityBefore: null,
      severityAfter,
      severityChange: severityAfter === null ? 'unavailable' : 'increased', // 0 prior occurrences: any post-release presence is an appearance
    };
  }

  if (presentBefore && presentAfter) {
    // Both sides: a release happening is NOT itself a regression. The
    // severity escalation decides.
    const change =
      severityBefore !== null && severityAfter !== null
        ? SEVERITY_ORDER[severityAfter] > SEVERITY_ORDER[severityBefore]
          ? 'increased'
          : SEVERITY_ORDER[severityAfter] < SEVERITY_ORDER[severityBefore]
            ? 'decreased'
            : 'unchanged'
        : 'unavailable';
    if (change === 'increased') {
      return {
        releaseRef: entry.releaseRef,
        releasedAt: entry.releasedAt,
        outcome: 'likely_regression',
        reason: `the signal was present before AND after release '${entry.releaseRef}', and its severity INCREASED across the boundary (${severityBefore} → ${severityAfter}) — regression-relevant (advisory)`,
        beforeOccurrenceIds: beforeIds,
        afterOccurrenceIds: afterIds,
        severityBefore,
        severityAfter,
        severityChange: 'increased',
      };
    }
    return {
      releaseRef: entry.releaseRef,
      releasedAt: entry.releasedAt,
      outcome: 'not_a_regression',
      reason:
        change === 'decreased'
          ? `the signal was present before AND after release '${entry.releaseRef}' and its severity DECREASED across the boundary (${severityBefore} → ${severityAfter}) — not a regression (never falsely promoted)`
          : `the signal was present before AND after release '${entry.releaseRef}' (boundary ${entry.releasedAt}) — a release happening is not itself a regression${severityBefore !== null && severityAfter !== null ? ` (severity unchanged: ${severityBefore} → ${severityAfter})` : ''}`,
      beforeOccurrenceIds: beforeIds,
      afterOccurrenceIds: afterIds,
      severityBefore,
      severityAfter,
      severityChange: change,
    };
  }

  if (presentBefore && !presentAfter) {
    // Present before, absent after: the release did not introduce it (it
    // resolved or persists elsewhere) — not a regression.
    return {
      releaseRef: entry.releaseRef,
      releasedAt: entry.releasedAt,
      outcome: 'not_a_regression',
      reason: `the signal was present BEFORE release '${entry.releaseRef}' and ABSENT after (boundary ${entry.releasedAt}) — not a regression (the failure pre-dates and did not recur at/after the release)`,
      beforeOccurrenceIds: beforeIds,
      afterOccurrenceIds: afterIds,
      severityBefore,
      severityAfter: null,
      severityChange: 'unavailable',
    };
  }

  // Unreachable (the empty-both-sides case is handled above); honest default.
  return {
    releaseRef: entry.releaseRef,
    releasedAt: entry.releasedAt,
    outcome: 'not_assessable',
    reason: `the occurrence timeline does not support an assessment against release '${entry.releaseRef}'`,
    beforeOccurrenceIds: beforeIds,
    afterOccurrenceIds: afterIds,
    severityBefore,
    severityAfter,
    severityChange: 'unavailable',
  };
}

/**
 * Assess the signal's regression status from its occurrence timeline and
 * the correlation entries. PURE, deterministic, ADVISORY.
 */
export function assessRegression(
  signal: EngineeringSignal,
  correlationEntries: readonly ReleaseCorrelationEntry[],
): RegressionAssessment {
  const correlated = correlationEntries.filter((entry) => entry.correlated);
  if (correlated.length === 0) {
    return {
      status: 'unavailable',
      reason:
        correlationEntries.length === 0
          ? 'release correlation is UNAVAILABLE: no release context was supplied (repository truth: no release authority exists yet — the release identity is never invented; the architectural gap is documented; the signal and its occurrences remain recorded)'
          : 'release correlation is UNAVAILABLE: every supplied release context was rejected (see the correlation entries for the typed reasons); the signal and its occurrences remain recorded',
      perRelease: [],
      likelyRegression: null,
    };
  }
  const perRelease = correlated.map((entry) => assessForRelease(signal, entry));
  const likely = perRelease.some((assessment) => assessment.outcome === 'likely_regression');
  return {
    status: 'assessed',
    reason: `${perRelease.length} correlated release context(s); ${perRelease.filter((a) => a.outcome === 'likely_regression').length} assessed likely_regression (ADVISORY — not a verification verdict, not a Work Item, not a workflow transition)`,
    perRelease,
    likelyRegression: likely,
  };
}

/** The derived signal attributes recomputed from the (deterministic) timeline. */
export function deriveSignalTimelineAttributes(occurrences: readonly SignalOccurrence[]): {
  firstObservedAt: string;
  lastObservedAt: string;
  latestSeverity: SignalSeverity;
  sources: readonly SignalOccurrence['source'][];
} {
  const timeline = sortedOccurrences(occurrences);
  const first = timeline[0]!;
  const last = timeline[timeline.length - 1]!;
  const sources = [...new Set(timeline.map((o) => o.source))];
  return {
    firstObservedAt: first.observedAt,
    lastObservedAt: last.observedAt,
    latestSeverity: last.severity,
    sources,
  };
}

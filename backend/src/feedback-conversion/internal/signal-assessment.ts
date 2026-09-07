/**
 * WORK-068 — the signal-group assessment engine (severity / scope / blast
 * radius). PURE + DETERMINISTIC.
 *
 * Assessment is ALWAYS DERIVED from the recorded WORK-067 signal truth —
 * never caller-supplied, never skipped. The factors are DISCRETE and
 * EXPLAINABLE (the WORK-040 prioritizer discipline — NO opaque AI score):
 *
 *   - severity: the recorded latest/peak severities + the escalation
 *     evidence (a WORK-067 likely-regression assessment is REGRESSION
 *     EVIDENCE, recorded verbatim — never promoted to a verdict);
 *   - scope: the observed spread — distinct environments, distinct
 *     sources, occurrence frequency;
 *   - blast radius: the discrete band (wide/moderate/narrow) with its
 *     derivation factors.
 *
 * The engine consumes ONLY the WORK-067 public record types
 * (EngineeringSignal) — it never re-derives correlation or regression
 * (that is the signal authority's model).
 */
import { SEVERITY_ORDER } from '../../engineering-signals/index.js';
import type {
  EngineeringSignal,
  SignalSeverity,
  SignalSource,
} from '../../engineering-signals/index.js';
import type {
  BlastRadiusAssessment,
  BlastRadiusBand,
  ConversionAssessmentFactor,
  SignalGroupAssessment,
  SignalRegressionEvidence,
} from '../types.js';

/** The peak recorded severity across a signal's occurrences. */
function peakSeverityOf(signal: EngineeringSignal): SignalSeverity {
  return signal.occurrences.reduce<SignalSeverity>(
    (peak, occurrence) => (SEVERITY_ORDER[occurrence.severity] > SEVERITY_ORDER[peak] ? occurrence.severity : peak),
    signal.latestSeverity,
  );
}

/** The latest occurrence time across the group (recorded values only). */
export function latestObservationTime(signals: readonly EngineeringSignal[]): string {
  return signals.reduce((latest, signal) => (signal.lastObservedAt > latest ? signal.lastObservedAt : latest), signals[0]?.firstObservedAt ?? '');
}

/** The earliest observation time across the group (recorded values only). */
export function earliestObservationTime(signals: readonly EngineeringSignal[]): string {
  const first = signals[0];
  if (!first) return '';
  return signals.reduce((earliest, signal) => (signal.firstObservedAt < earliest ? signal.firstObservedAt : earliest), first.firstObservedAt);
}

/**
 * Derive the blast-radius band + factors from the group's recorded spread.
 * Pure + deterministic:
 *   - 'wide'    — cross-environment AND cross-source, or ≥ 10 occurrences;
 *   - 'moderate'— cross-source OR cross-environment, or ≥ 4 occurrences;
 *   - 'narrow'  — otherwise.
 */
export function assessBlastRadius(input: {
  environmentIds: readonly string[];
  sources: readonly SignalSource[];
  occurrenceCount: number;
}): BlastRadiusAssessment {
  const factors: ConversionAssessmentFactor[] = [];
  const crossEnvironment = input.environmentIds.length > 1;
  const crossSource = input.sources.length > 1;
  if (crossEnvironment) {
    factors.push({
      kind: 'cross-environment-spread',
      weight: 2,
      detail: `observed in ${input.environmentIds.length} environments (${input.environmentIds.join(', ')})`,
    });
  }
  if (crossSource) {
    factors.push({
      kind: 'cross-source-confirmation',
      weight: 2,
      detail: `confirmed by ${input.sources.length} source types (${input.sources.join(', ')})`,
    });
  }
  if (input.occurrenceCount >= 10) {
    factors.push({
      kind: 'occurrence-frequency',
      weight: 2,
      detail: `${input.occurrenceCount} recorded occurrences`,
    });
  } else if (input.occurrenceCount >= 4) {
    factors.push({
      kind: 'occurrence-frequency',
      weight: 1,
      detail: `${input.occurrenceCount} recorded occurrences`,
    });
  }
  const wide = (crossEnvironment && crossSource) || input.occurrenceCount >= 10;
  const moderate = crossEnvironment || crossSource || input.occurrenceCount >= 4;
  const band: BlastRadiusBand = wide ? 'wide' : moderate ? 'moderate' : 'narrow';
  return {
    band,
    factors,
    environmentIds: [...input.environmentIds],
    sources: [...input.sources],
    occurrenceCount: input.occurrenceCount,
  };
}

/**
 * Assess one signal group (the signals sharing a logicalFailureKey). The
 * full severity/scope/blast-radius assessment with its verbatim advisory
 * regression evidence. Pure + deterministic — identical signals produce a
 * byte-identical assessment.
 */
export function assessSignalGroup(signals: readonly EngineeringSignal[]): SignalGroupAssessment {
  const first = signals[0];
  if (signals.length === 0 || !first) {
    throw new Error('assessSignalGroup requires a non-empty signal group');
  }
  const environmentIds = [...new Set(signals.map((signal) => signal.environmentId))];
  const sources = [...new Set(signals.flatMap((signal) => [...signal.sources]))];
  const occurrenceCount = signals.reduce((sum, signal) => sum + signal.occurrences.length, 0);

  // The RECORDED severities (never promoted, never invented):
  const latestSeverity = signals.reduce<SignalSeverity>(
    (max, signal) => (SEVERITY_ORDER[signal.latestSeverity] > SEVERITY_ORDER[max] ? signal.latestSeverity : max),
    first.latestSeverity,
  );
  const peakOfFirst = peakSeverityOf(first);
  const peakSeverity = signals.reduce<SignalSeverity>(
    (max, signal) => (SEVERITY_ORDER[peakSeverityOf(signal)] > SEVERITY_ORDER[max] ? peakSeverityOf(signal) : max),
    peakOfFirst,
  );

  // The advisory regression evidence — VERBATIM from WORK-067 (never a verdict):
  const regressionOutcomes: SignalRegressionEvidence[] = signals.map((signal) => ({
    signalId: signal.signalId,
    environmentId: signal.environmentId,
    likelyRegression: signal.regression.likelyRegression,
  }));
  const regressionSignals = regressionOutcomes.filter((entry) => entry.likelyRegression === true);

  const factors: ConversionAssessmentFactor[] = [];
  factors.push({
    kind: 'signal-severity',
    weight: SEVERITY_ORDER[peakSeverity],
    detail: `the recorded peak severity is '${peakSeverity}' (latest '${latestSeverity}')`,
  });
  if (regressionSignals.length > 0) {
    factors.push({
      kind: 'regression-evidence',
      weight: 3,
      detail: `${regressionSignals.length}/${regressionOutcomes.length} signal(s) carry the WORK-067 advisory likely-regression assessment (recorded verbatim, never a verdict)`,
    });
  }
  const lastObserved = latestObservationTime(signals);
  factors.push({
    kind: 'observation-recency',
    weight: 1,
    detail: `last observed at ${lastObserved} (recorded value)`,
  });

  const blastRadius = assessBlastRadius({ environmentIds, sources, occurrenceCount });
  factors.push(...blastRadius.factors);

  const reason =
    `the logical failure '${first.logicalFailureKey}' was observed ${occurrenceCount} time(s) ` +
    `across ${environmentIds.length} environment(s) by ${sources.length} source type(s); ` +
    `the recorded peak severity is '${peakSeverity}'; ` +
    `${regressionSignals.length}/${regressionOutcomes.length} signal(s) carry the advisory likely-regression assessment; ` +
    `the derived blast radius is '${blastRadius.band}'.`;

  return {
    latestSeverity,
    peakSeverity,
    regressionOutcomes,
    blastRadius,
    factors,
    reason,
  };
}

/** The group's aggregate occurrence provenance (preserved verbatim). */
export function occurrenceProvenanceOf(
  signals: readonly EngineeringSignal[],
): ReadonlyArray<{
  signalId: string;
  occurrenceId: string;
  source: SignalSource;
  observedAt: string;
  observationRef: { kind: string; ref: string; detail?: string };
}> {
  return signals.flatMap((signal) =>
    signal.occurrences.map((occurrence) => ({
      signalId: signal.signalId,
      occurrenceId: occurrence.occurrenceId,
      source: occurrence.source,
      observedAt: occurrence.observedAt,
      observationRef: occurrence.observationRef as { kind: string; ref: string; detail?: string },
    })),
  );
}

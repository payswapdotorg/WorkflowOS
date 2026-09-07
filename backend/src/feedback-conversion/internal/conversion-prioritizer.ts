/**
 * WORK-068 — the conversion prioritizer: the discrete, explainable
 * priority band assigned RELATIVE to the existing backlog.
 *
 * The WORK-040 prioritizer discipline: NO opaque AI score — every factor
 * is discrete + traceable. The priority is derived from the assessment
 * (severity, regression evidence, blast radius, occurrence frequency) and
 * positioned relative to the existing backlog (the open-item counts are
 * recorded as {@link BacklogContext}).
 *
 * The factor weights sum into a deterministic score; the score maps to a
 * discrete band:
 *   - 'high'   — score ≥ 8 (e.g. a critical peak severity alone, or high
 *                severity + regression evidence);
 *   - 'medium' — score ≥ 4 (e.g. a high peak severity alone);
 *   - 'low'    — otherwise.
 */
import type {
  BacklogContext,
  ConversionPriority,
  ConversionPriorityFactor,
  SignalGroupAssessment,
} from '../types.js';
import { SEVERITY_ORDER } from '../../engineering-signals/index.js';

/**
 * Derive the priority + its explainable factors from the assessment.
 * PURE + deterministic.
 */
export function prioritizeProposal(input: {
  assessment: SignalGroupAssessment;
  openWorkItemCount: number;
}): { priority: ConversionPriority; factors: readonly ConversionPriorityFactor[] } {
  const factors: ConversionPriorityFactor[] = [];
  const severityWeight = SEVERITY_ORDER[input.assessment.peakSeverity];
  if (severityWeight >= 3) {
    factors.push({
      kind: 'severity-escalation',
      weight: 8,
      detail: `the recorded peak severity is 'critical'`,
    });
  } else if (severityWeight === 2) {
    factors.push({
      kind: 'severity-escalation',
      weight: 5,
      detail: `the recorded peak severity is 'high'`,
    });
  } else if (severityWeight === 1) {
    factors.push({
      kind: 'severity-escalation',
      weight: 2,
      detail: `the recorded peak severity is 'medium'`,
    });
  }

  const regressionSignals = input.assessment.regressionOutcomes.filter(
    (entry) => entry.likelyRegression === true,
  );
  if (regressionSignals.length > 0) {
    factors.push({
      kind: 'regression-evidence',
      weight: 4,
      detail: `${regressionSignals.length}/${input.assessment.regressionOutcomes.length} signal(s) carry the advisory likely-regression assessment (WORK-067 evidence, never a verdict)`,
    });
  }

  if (input.assessment.blastRadius.band === 'wide') {
    factors.push({
      kind: 'blast-radius-wide',
      weight: 3,
      detail: `the blast radius is wide: ${input.assessment.blastRadius.environmentIds.length} environment(s), ${input.assessment.blastRadius.sources.length} source type(s), ${input.assessment.blastRadius.occurrenceCount} occurrence(s)`,
    });
  } else if (input.assessment.blastRadius.band === 'moderate') {
    factors.push({
      kind: 'blast-radius-moderate',
      weight: 2,
      detail: `the blast radius is moderate: ${input.assessment.blastRadius.environmentIds.length} environment(s), ${input.assessment.blastRadius.sources.length} source type(s), ${input.assessment.blastRadius.occurrenceCount} occurrence(s)`,
    });
  }

  if (input.assessment.blastRadius.sources.length > 1) {
    factors.push({
      kind: 'cross-source-confirmation',
      weight: 2,
      detail: `the logical failure is confirmed by ${input.assessment.blastRadius.sources.length} independent source types`,
    });
  }

  if (input.assessment.blastRadius.occurrenceCount >= 10) {
    factors.push({
      kind: 'occurrence-frequency',
      weight: 2,
      detail: `${input.assessment.blastRadius.occurrenceCount} recorded occurrences`,
    });
  } else if (input.assessment.blastRadius.occurrenceCount >= 4) {
    factors.push({
      kind: 'occurrence-frequency',
      weight: 1,
      detail: `${input.assessment.blastRadius.occurrenceCount} recorded occurrences`,
    });
  }

  if (input.openWorkItemCount >= 20) {
    factors.push({
      kind: 'backlog-pressure',
      weight: 1,
      detail: `the existing backlog is large (${input.openWorkItemCount} open Work Items) — the proposal is positioned relative to it`,
    });
  }

  const score = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const priority: ConversionPriority = score >= 8 ? 'high' : score >= 4 ? 'medium' : 'low';
  return { priority, factors };
}

/**
 * The priority score (the deterministic sum of the factor weights — used
 * ONLY for the stable ordering among the assessed proposals).
 */
export function priorityScore(factors: readonly ConversionPriorityFactor[]): number {
  return factors.reduce((sum, factor) => sum + factor.weight, 0);
}

/**
 * Derive the backlog context — the RELATIVE priority record: the open-item
 * count + the proposal's rank among the assessed proposals (deterministic:
 * priority score DESC, logicalFailureKey ASC).
 */
export function deriveBacklogContext(input: {
  openWorkItemCount: number;
  rankedProposals: ReadonlyArray<{ logicalFailureKey: string; factors: readonly ConversionPriorityFactor[] }>;
  logicalFailureKey: string;
}): BacklogContext {
  const index = input.rankedProposals.findIndex(
    (proposal) => proposal.logicalFailureKey === input.logicalFailureKey,
  );
  return {
    openWorkItemCount: input.openWorkItemCount,
    rankAmongAssessedProposals: index + 1,
    assessedProposalCount: input.rankedProposals.length,
  };
}

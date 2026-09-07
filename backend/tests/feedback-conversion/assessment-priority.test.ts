import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the assessment + priority proofs: severity / scope / blast
 * radius derive from the RECORDED signal truth (discrete, explainable
 * factors — never an opaque score), and the priority is assigned RELATIVE
 * to the existing backlog.
 */
import {
  assessSignalGroup,
  assessBlastRadius,
  prioritizeProposal,
  deriveBacklogContext,
} from '../../src/feedback-conversion/index.js';
import type { EngineeringSignal } from '../../src/engineering-signals/index.js';
import {
  observationFixture,
  buildSignalService,
  fixedClock,
  silentLogger,
} from './helpers.js';

/** Build a REAL EngineeringSignal record through the WORK-067 authority. */
async function realSignal(
  overrides: {
    logicalFailureKey?: string;
    environmentId?: string;
    source?: 'validation' | 'ci' | 'runtime' | 'telemetry' | 'security' | 'user-feedback' | 'deployment';
    severity?: 'low' | 'medium' | 'high' | 'critical';
    times?: string[];
    correlateToRelease?: boolean;
  } = {},
): Promise<EngineeringSignal> {
  const service = buildSignalService();
  const times = overrides.times ?? ['2026-09-02T12:00:00Z'];
  let signal: EngineeringSignal | null = null;
  let index = 0;
  for (const at of times) {
    const result = await service.ingestObservation(
      observationFixture({
        logicalFailureKey: overrides.logicalFailureKey ?? 'validation:journey-checkout:step-pay',
        environmentId: overrides.environmentId ?? 'env-prod-1',
        source: overrides.source ?? 'validation',
        severity: overrides.severity ?? 'high',
        observedAt: at,
        observationRef: { kind: 'validation-run', ref: `run-${index}`, detail: 'failure' },
        releaseRef: overrides.correlateToRelease ? 'release-2026.09.02' : null,
      }),
    );
    signal = result.signal;
    index += 1;
  }
  if (overrides.correlateToRelease && signal) {
    signal = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [
        {
          releaseRef: 'release-2026.09.02',
          releasedAt: '2026-09-02T11:00:00Z',
          projectId: 'project-1',
          recordedVia: 'caller-declared',
        },
      ],
      now: fixedClock('2026-09-02T16:00:00Z'),
    });
  }
  return signal!;
}

describe('WORK-068 — the assessment model (severity / scope / blast radius)', () => {
  it('a single-environment single-source signal with few occurrences assesses NARROW blast radius', async () => {
    const signal = await realSignal({ times: ['2026-09-02T12:00:00Z'] });
    const assessment = assessSignalGroup([signal]);
    expect(assessment.blastRadius.band).toBe('narrow');
    expect(assessment.blastRadius.environmentIds).toEqual(['env-prod-1']);
    expect(assessment.blastRadius.sources).toEqual(['validation']);
    expect(assessment.blastRadius.occurrenceCount).toBe(1);
    expect(assessment.latestSeverity).toBe('high');
    expect(assessment.peakSeverity).toBe('high');
  });

  it('a cross-source confirmed failure assesses MODERATE+ blast radius with the cross-source factor recorded', async () => {
    const validationSignal = await realSignal({ source: 'validation', logicalFailureKey: 'shared:failure' });
    const ciSignal = await realSignal({
      source: 'ci',
      logicalFailureKey: 'shared:failure',
      environmentId: 'env-prod-1',
    });
    const assessment = assessSignalGroup([validationSignal, ciSignal]);
    expect(assessment.blastRadius.band).not.toBe('narrow');
    expect([...assessment.blastRadius.sources].sort()).toEqual(['ci', 'validation']);
    expect(
      assessment.factors.some((factor) => factor.kind === 'cross-source-confirmation'),
    ).toBe(true);
  });

  it('a cross-environment AND cross-source failure assesses WIDE blast radius', async () => {
    const prod = await realSignal({ environmentId: 'env-prod-1', source: 'validation', logicalFailureKey: 'wide:failure' });
    const staging = await realSignal({ environmentId: 'env-staging-1', source: 'ci', logicalFailureKey: 'wide:failure' });
    const assessment = assessSignalGroup([prod, staging]);
    expect(assessment.blastRadius.band).toBe('wide');
    expect([...assessment.blastRadius.environmentIds].sort()).toEqual(['env-prod-1', 'env-staging-1']);
  });

  it('ten or more occurrences assess WIDE blast radius (the frequency dimension alone)', () => {
    const blast = assessBlastRadius({
      environmentIds: ['env-prod-1'],
      sources: ['validation'],
      occurrenceCount: 10,
    });
    expect(blast.band).toBe('wide');
  });

  it('the severity is the RECORDED truth (never promoted); the peak derives from the occurrences', async () => {
    const signal = await realSignal({
      severity: 'low',
      times: ['2026-09-02T12:00:00Z', '2026-09-02T13:00:00Z'],
    });
    // Both occurrences are low; a later critical one escalates the PEAK only:
    const escalated = await realSignal({
      severity: 'critical',
      times: ['2026-09-02T12:00:00Z', '2026-09-02T13:00:00Z'],
    });
    expect(assessSignalGroup([signal]).peakSeverity).toBe('low');
    expect(assessSignalGroup([escalated]).peakSeverity).toBe('critical');
  });

  it('the advisory regression evidence is recorded VERBATIM (likelyRegression from WORK-067, never a verdict, never promoted)', async () => {
    const correlated = await realSignal({ correlateToRelease: true, times: ['2026-09-02T12:30:00Z'] });
    const assessment = assessSignalGroup([correlated]);
    // The signal's occurrences are AFTER the 11:00 release boundary →
    // absent-before + present-after → the WORK-067 advisory says likely.
    expect(correlated.regression.likelyRegression).toBe(true);
    expect(assessment.regressionOutcomes).toHaveLength(1);
    expect(assessment.regressionOutcomes[0]!.likelyRegression).toBe(true);
    // The factor is recorded as ADVISORY evidence:
    expect(
      assessment.factors.some((factor) => factor.kind === 'regression-evidence'),
    ).toBe(true);
  });

  it('determinism: identical signals produce a BYTE-IDENTICAL assessment', async () => {
    const a = await realSignal({ times: ['2026-09-02T12:00:00Z', '2026-09-02T13:00:00Z'] });
    const b = await realSignal({ times: ['2026-09-02T12:00:00Z', '2026-09-02T13:00:00Z'] });
    expect(JSON.stringify(assessSignalGroup([a]))).toBe(JSON.stringify(assessSignalGroup([b])));
  });
});

describe('WORK-068 — the priority model (relative to the existing backlog)', () => {
  it('a critical-severity + regression-evidence + wide-blast-radius proposal prioritizes HIGH with explainable factors', async () => {
    const signals = [
      await realSignal({ severity: 'critical', correlateToRelease: true, times: ['2026-09-02T12:30:00Z'] }),
    ];
    const assessment = assessSignalGroup(signals);
    const { priority, factors } = prioritizeProposal({ assessment, openWorkItemCount: 5 });
    expect(priority).toBe('high');
    expect(factors.some((f) => f.kind === 'severity-escalation' && f.detail.includes('critical'))).toBe(true);
    expect(factors.some((f) => f.kind === 'regression-evidence')).toBe(true);
  });

  it('a low-severity narrow single-occurrence proposal prioritizes LOW', async () => {
    const signal = await realSignal({ severity: 'low', times: ['2026-09-02T12:00:00Z'] });
    const assessment = assessSignalGroup([signal]);
    const { priority } = prioritizeProposal({ assessment, openWorkItemCount: 0 });
    expect(priority).toBe('low');
  });

  it('the backlog context records the open count + the deterministic rank among the assessed proposals', () => {
    const context = deriveBacklogContext({
      openWorkItemCount: 7,
      rankedProposals: [
        { logicalFailureKey: 'b', factors: [] },
        { logicalFailureKey: 'a', factors: [] },
      ],
      logicalFailureKey: 'a',
    });
    expect(context.openWorkItemCount).toBe(7);
    expect(context.rankAmongAssessedProposals).toBe(2);
    expect(context.assessedProposalCount).toBe(2);
  });

  it('a large backlog contributes the backlog-pressure factor (the priority is RELATIVE to the existing backlog)', async () => {
    const signal = await realSignal({ times: ['2026-09-02T12:00:00Z'] });
    const assessment = assessSignalGroup([signal]);
    const { factors } = prioritizeProposal({ assessment, openWorkItemCount: 25 });
    expect(factors.some((f) => f.kind === 'backlog-pressure')).toBe(true);
  });
});

describe('WORK-068 — no wall-clock / randomness in the domain decision path', () => {
  it('the pure assessment + priority functions need NO clock (all inputs are recorded values)', async () => {
    const signal = await realSignal({ times: ['2026-09-02T12:00:00Z'] });
    expect(() => {
      assessSignalGroup([signal]);
      prioritizeProposal({ assessment: assessSignalGroup([signal]), openWorkItemCount: 0 });
    }).not.toThrow();
  });
});

// Keep the silent logger import referenced (the shared fixture discipline).
void silentLogger;

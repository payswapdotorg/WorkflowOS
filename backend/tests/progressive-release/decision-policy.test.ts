/**
 * WORK-069 — the deterministic continue/halt/recover derivation (the
 * governed-decision contract): every cell of the policy matrix, its typed
 * reason, its explainability, and its determinism (the same facts always
 * derive the same decision — no clock, no randomness, no I/O).
 */
import { describe, it, expect } from 'vitest';
import {
  deriveProgressiveDecision,
  PROGRESSIVE_POLICY_VERSION,
  PROGRESSIVE_DECISION_REASONS,
} from '../../src/progressive-release/index.js';
import type {
  PriorRolloutState,
  ProgressiveDecisionReason,
  RuntimeObservationStatus,
  ValidationEvidenceStatus,
} from '../../src/progressive-release/index.js';
import type { ValidationRun } from '../../src/continuous-validation/index.js';

const NO_HISTORY: PriorRolloutState = {
  previouslyHalted: false,
  previouslyRecovered: false,
  highestDecidedStage: null,
};

const HEALTHY_RUN = { status: 'completed', outcome: { kind: 'healthy' } } as unknown as ValidationRun;
const FAILED_RUN = { status: 'completed', outcome: { kind: 'validation_failure', failures: [] } } as unknown as ValidationRun;
const POLICY_RUN = { status: 'completed', outcome: { kind: 'effect_policy_violation' } } as unknown as ValidationRun;
const ENV_RUN = { status: 'completed', outcome: { kind: 'environment_error' } } as unknown as ValidationRun;

function evidence(run: ValidationRun): ValidationEvidenceStatus {
  return { usable: true, run };
}
function evidenceGap(reason: Extract<ProgressiveDecisionReason, `HALT_VALIDATION_${string}`>): ValidationEvidenceStatus {
  return { usable: false, reason };
}
const runtime = (state: RuntimeObservationStatus['state']): RuntimeObservationStatus =>
  state === 'unavailable'
    ? { state: 'unavailable' }
    : {
        state,
        observation: {
          kind: 'deployment',
          deploymentId: 'dpl-1',
          deploymentStatus:
            state === 'healthy' ? 'ready' : state === 'unhealthy' ? 'error' : 'queued',
          observedAt: '2026-09-01T12:10:00Z',
        },
      };

describe('WORK-069 — the deterministic decision policy', () => {
  it('the policy version is pinned (every decision records its governing policy)', () => {
    expect(PROGRESSIVE_POLICY_VERSION).toBe('work-069-progressive-release-policy-1');
  });

  it('CONTINUE — the only continue cell: a COMPLETED HEALTHY validation + a READY runtime observation', () => {
    const result = deriveProgressiveDecision({
      stage: 'canary',
      validationEvidence: evidence(HEALTHY_RUN),
      runtimeObservation: runtime('healthy'),
      priorRolloutState: NO_HISTORY,
    });
    expect(result.decision).toBe('continue');
    expect(result.reason).toBe('CONTINUE_VALIDATION_HEALTHY_RUNTIME_READY');
    expect(result.explanation).toMatch(/HEALTHY/);
    expect(result.explanation).toMatch(/READY/);
  });

  it('the continue cell holds at EVERY stage (a healthy rollout continues at partial and full)', () => {
    for (const stage of ['canary', 'partial', 'full'] as const) {
      const result = deriveProgressiveDecision({
        stage,
        validationEvidence: evidence(HEALTHY_RUN),
        runtimeObservation: runtime('healthy'),
        priorRolloutState: NO_HISTORY,
      });
      expect(result.decision, `stage ${stage}`).toBe('continue');
    }
  });

  it('RECOVER — an effect_policy_violation at ANY stage (a FORBIDDEN effect in production is the rollback case)', () => {
    for (const stage of ['canary', 'partial', 'full'] as const) {
      const result = deriveProgressiveDecision({
        stage,
        validationEvidence: evidence(POLICY_RUN),
        runtimeObservation: runtime('healthy'),
        priorRolloutState: NO_HISTORY,
      });
      expect(result.decision, `stage ${stage}`).toBe('recover');
      expect(result.reason, `stage ${stage}`).toBe('RECOVER_EFFECT_POLICY_VIOLATION');
    }
  });

  it('RECOVER — a validation_failure while contained at CANARY (the canary exists to catch exactly this)', () => {
    const result = deriveProgressiveDecision({
      stage: 'canary',
      validationEvidence: evidence(FAILED_RUN),
      runtimeObservation: runtime('healthy'),
      priorRolloutState: NO_HISTORY,
    });
    expect(result.decision).toBe('recover');
    expect(result.reason).toBe('RECOVER_CANARY_VALIDATION_FAILURE');
  });

  it('RECOVER — an UNHEALTHY runtime observation while contained at CANARY', () => {
    const result = deriveProgressiveDecision({
      stage: 'canary',
      validationEvidence: evidence(HEALTHY_RUN),
      runtimeObservation: runtime('unhealthy'),
      priorRolloutState: NO_HISTORY,
    });
    expect(result.decision).toBe('recover');
    expect(result.reason).toBe('RECOVER_CANARY_RUNTIME_UNHEALTHY');
  });

  it('HALT — a validation_failure at the EXPOSED stages (partial/full: stop the rollout, do not auto-rollback)', () => {
    for (const stage of ['partial', 'full'] as const) {
      const result = deriveProgressiveDecision({
        stage,
        validationEvidence: evidence(FAILED_RUN),
        runtimeObservation: runtime('healthy'),
        priorRolloutState: NO_HISTORY,
      });
      expect(result.decision, `stage ${stage}`).toBe('halt');
      expect(result.reason, `stage ${stage}`).toBe('HALT_VALIDATION_FAILURE');
    }
  });

  it('HALT — an environment_error at EVERY stage (the evidence itself is unusable: stop, never roll back)', () => {
    for (const stage of ['canary', 'partial', 'full'] as const) {
      const result = deriveProgressiveDecision({
        stage,
        validationEvidence: evidence(ENV_RUN),
        runtimeObservation: runtime('healthy'),
        priorRolloutState: NO_HISTORY,
      });
      expect(result.decision, `stage ${stage}`).toBe('halt');
      expect(result.reason, `stage ${stage}`).toBe('HALT_VALIDATION_ENVIRONMENT_ERROR');
    }
  });

  it('HALT — an UNHEALTHY runtime observation at the EXPOSED stages', () => {
    for (const stage of ['partial', 'full'] as const) {
      const result = deriveProgressiveDecision({
        stage,
        validationEvidence: evidence(HEALTHY_RUN),
        runtimeObservation: runtime('unhealthy'),
        priorRolloutState: NO_HISTORY,
      });
      expect(result.decision, `stage ${stage}`).toBe('halt');
      expect(result.reason, `stage ${stage}`).toBe('HALT_RUNTIME_UNHEALTHY');
    }
  });

  it('SEVERITY ORDERING — the effect_policy_violation outranks a runtime failure at the SAME stage (the most severe first)', () => {
    // canary + policy violation + unhealthy runtime → the policy violation decides:
    const result = deriveProgressiveDecision({
      stage: 'canary',
      validationEvidence: evidence(POLICY_RUN),
      runtimeObservation: runtime('unhealthy'),
      priorRolloutState: NO_HISTORY,
    });
    expect(result.decision).toBe('recover');
    expect(result.reason).toBe('RECOVER_EFFECT_POLICY_VIOLATION');
  });

  it('the recorded rollout state gates everything (already halted / already recovered / stage regression — §14)', () => {
    // already recovered → the rollout is DONE:
    expect(
      deriveProgressiveDecision({
        stage: 'canary',
        validationEvidence: evidence(HEALTHY_RUN),
        runtimeObservation: runtime('healthy'),
        priorRolloutState: { previouslyHalted: false, previouslyRecovered: true, highestDecidedStage: 'canary' },
      }).reason,
    ).toBe('HALT_ROLLOUT_PREVIOUSLY_RECOVERED');
    // already halted → the rollout is STOPPED (even with healthy facts):
    expect(
      deriveProgressiveDecision({
        stage: 'partial',
        validationEvidence: evidence(HEALTHY_RUN),
        runtimeObservation: runtime('healthy'),
        priorRolloutState: { previouslyHalted: true, previouslyRecovered: false, highestDecidedStage: 'canary' },
      }).reason,
    ).toBe('HALT_ROLLOUT_PREVIOUSLY_HALTED');
    // a stage EARLIER than an already-judged stage → invalid transition:
    expect(
      deriveProgressiveDecision({
        stage: 'canary',
        validationEvidence: evidence(HEALTHY_RUN),
        runtimeObservation: runtime('healthy'),
        priorRolloutState: { previouslyHalted: false, previouslyRecovered: false, highestDecidedStage: 'partial' },
      }).reason,
    ).toBe('HALT_INVALID_STAGE_TRANSITION');
    // the SAME stage as the highest judged stage is NOT a regression (re-evaluation):
    expect(
      deriveProgressiveDecision({
        stage: 'partial',
        validationEvidence: evidence(HEALTHY_RUN),
        runtimeObservation: runtime('healthy'),
        priorRolloutState: { previouslyHalted: false, previouslyRecovered: false, highestDecidedStage: 'partial' },
      }).decision,
    ).toBe('continue');
  });

  it('DETERMINISM — the identical facts derive the byte-identical decision (100 repetitions)', () => {
    const facts = {
      stage: 'partial' as const,
      validationEvidence: evidence(FAILED_RUN),
      runtimeObservation: runtime('unhealthy'),
      priorRolloutState: NO_HISTORY,
    };
    const first = deriveProgressiveDecision(facts);
    for (let i = 0; i < 100; i += 1) {
      expect(deriveProgressiveDecision(facts)).toEqual(first);
    }
  });

  it('every reason the policy can emit is in the CLOSED vocabulary (no invented reasons)', () => {
    const emitted = new Set<string>();
    const cases: Array<PriorRolloutState> = [
      NO_HISTORY,
      { previouslyHalted: true, previouslyRecovered: false, highestDecidedStage: null },
      { previouslyHalted: false, previouslyRecovered: true, highestDecidedStage: null },
      { previouslyHalted: false, previouslyRecovered: false, highestDecidedStage: 'full' },
    ];
    const evidences: ValidationEvidenceStatus[] = [
      evidence(HEALTHY_RUN),
      evidence(FAILED_RUN),
      evidence(POLICY_RUN),
      evidence(ENV_RUN),
      evidenceGap('HALT_VALIDATION_RUN_NOT_FOUND'),
      evidenceGap('HALT_VALIDATION_RELEASE_REF_MISMATCH'),
    ];
    const runtimes: RuntimeObservationStatus[] = [runtime('healthy'), runtime('unhealthy'), runtime('not-ready'), runtime('unavailable')];
    for (const priorRolloutState of cases) {
      for (const stage of ['canary', 'partial', 'full'] as const) {
        for (const validationEvidence of evidences) {
          for (const runtimeObservation of runtimes) {
            emitted.add(deriveProgressiveDecision({ stage, validationEvidence, runtimeObservation, priorRolloutState }).reason);
          }
        }
      }
    }
    expect([...emitted].every((r) => (PROGRESSIVE_DECISION_REASONS as readonly string[]).includes(r))).toBe(true);
  });
});

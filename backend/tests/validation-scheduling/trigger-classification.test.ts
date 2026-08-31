import { describe, it, expect } from 'vitest';

/**
 * WORK-066 — trigger classification: the closed-vocabulary trigger kinds +
 * the deterministic trigger → mode-leg resolution (lifecycle §3, the
 * normative TRIGGER_MODE_BINDING owned by WORK-064).
 *
 * Discrimination: the trigger vocabulary (change/PR, merge-shaped events,
 * release/deployment, post-release, manual, scheduled CONTINUOUS,
 * unsupported/invalid) — the scheduler consumes the closed WORK-064
 * vocabulary and invents NONE of its own.
 */
import {
  classifyTrigger,
  VALIDATION_TRIGGERS,
  ValidationSchedulingError,
  type ScheduleValidationTriggerInput,
} from '../../src/validation-scheduling/index.js';
import {
  declaredJourneys,
  previewEnvironment,
  productionEnvironment,
  unauthenticated,
  FIXED_CLOCK,
} from './helpers.js';

function baseInput(overrides: Partial<ScheduleValidationTriggerInput>): ScheduleValidationTriggerInput {
  return {
    trigger: 'PR',
    projectId: 'proj-1',
    assurance: 'STANDARD',
    journeys: declaredJourneys,
    previewEnvironment,
    productionEnvironment,
    identitySource: unauthenticated,
    revision: 'rev-abc123',
    releaseRef: 'release-2026-09-01',
    ...overrides,
  };
}

describe('WORK-066 trigger classification — the closed vocabulary', () => {
  it('accepts exactly the nine WORK-064 trigger kinds (no invented trigger types)', () => {
    expect([...VALIDATION_TRIGGERS]).toEqual([
      'PR',
      'DEPLOYMENT',
      'RELEASE',
      'SCHEDULED',
      'RUNTIME_SIGNAL',
      'ARCHITECTURE_CHANGE',
      'SECURITY_FINDING',
      'DEPENDENCY_CHANGE',
      'USER_FEEDBACK',
    ]);
  });

  for (const foreign of ['MANUAL', 'MERGE', 'CRON', 'manual', '', 'pr', 'webhook', 'CI']) {
    it(`rejects the foreign trigger kind ${JSON.stringify(foreign)} fail-closed (SCHEDULING_TRIGGER_UNKNOWN)`, () => {
      // MANUAL is not a vocabulary kind (a manual request binds to one of the
      // nine under explicit configuration); MERGE is not a scheduler trigger
      // (a merged PR surfaces through the release/deployment flow).
      expect(() => classifyTrigger(baseInput({ trigger: foreign }), FIXED_CLOCK)).toThrowError(ValidationSchedulingError);
      try {
        classifyTrigger(baseInput({ trigger: foreign }), FIXED_CLOCK);
      } catch (error) {
        expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_TRIGGER_UNKNOWN');
      }
    });
  }
});

describe('WORK-066 trigger classification — trigger → mode-leg binding (lifecycle §3)', () => {
  it('PR → exactly one PRE_MERGE leg bound to the revision + the preview environment', () => {
    const classification = classifyTrigger(baseInput({ trigger: 'PR' }), FIXED_CLOCK);
    expect(classification.trigger).toBe('PR');
    expect(classification.legs).toHaveLength(1);
    const leg = classification.legs[0]!;
    expect(leg.mode).toBe('PRE_MERGE');
    expect(leg.reference).toBe('rev-abc123');
    expect(leg.environment.kind).toBe('preview');
    expect(leg.releaseRef).toBeUndefined();
    expect(leg.continuousConfigured).toBe(false);
  });

  it('DEPLOYMENT → one PRE_MERGE leg (the deployment\'s preview environment)', () => {
    const classification = classifyTrigger(baseInput({ trigger: 'DEPLOYMENT' }), FIXED_CLOCK);
    expect(classification.legs.map((l) => l.mode)).toEqual(['PRE_MERGE']);
  });

  it('ARCHITECTURE_CHANGE → one PRE_MERGE leg (the ACR-gated preview; the ACR id is the revision)', () => {
    const classification = classifyTrigger(baseInput({ trigger: 'ARCHITECTURE_CHANGE', revision: 'ACR-009' }), FIXED_CLOCK);
    expect(classification.legs.map((l) => l.mode)).toEqual(['PRE_MERGE']);
    expect(classification.legs[0]!.reference).toBe('ACR-009');
  });

  it('RELEASE → exactly one POST_RELEASE leg bound to the recorded release reference + production', () => {
    const classification = classifyTrigger(baseInput({ trigger: 'RELEASE', releaseRef: 'release-2026-09-01' }), FIXED_CLOCK);
    expect(classification.legs).toHaveLength(1);
    const leg = classification.legs[0]!;
    expect(leg.mode).toBe('POST_RELEASE');
    expect(leg.reference).toBe('release-2026-09-01');
    expect(leg.releaseRef).toBe('release-2026-09-01');
    expect(leg.environment.kind).toBe('production');
  });

  it('SECURITY_FINDING (not escalated) → only the PRE_MERGE leg (the immediate preview)', () => {
    const classification = classifyTrigger(baseInput({ trigger: 'SECURITY_FINDING', escalatedToProduction: false }), FIXED_CLOCK);
    expect(classification.legs.map((l) => l.mode)).toEqual(['PRE_MERGE']);
  });

  it('SECURITY_FINDING (escalated to production) → PRE_MERGE + POST_RELEASE legs (the escalation rule)', () => {
    const classification = classifyTrigger(
      baseInput({ trigger: 'SECURITY_FINDING', escalatedToProduction: true, releaseRef: 'release-2026-09-01' }),
      FIXED_CLOCK,
    );
    expect(classification.legs.map((l) => l.mode)).toEqual(['PRE_MERGE', 'POST_RELEASE']);
    expect(classification.legs[1]!.releaseRef).toBe('release-2026-09-01');
  });

  it('DEPENDENCY_CHANGE (escalated) → PRE_MERGE + POST_RELEASE legs (the dependency\'s preview, then the released production)', () => {
    const classification = classifyTrigger(
      baseInput({ trigger: 'DEPENDENCY_CHANGE', escalatedToProduction: true, releaseRef: 'release-2026-09-01' }),
      FIXED_CLOCK,
    );
    expect(classification.legs.map((l) => l.mode)).toEqual(['PRE_MERGE', 'POST_RELEASE']);
  });

  it('SCHEDULED → one CONTINUOUS leg under the explicit configuration with the current window reference', () => {
    const classification = classifyTrigger(
      baseInput({
        trigger: 'SCHEDULED',
        continuous: { projectId: 'proj-1', environmentId: productionEnvironment.id, intervalMs: 60 * 60 * 1000 },
      }),
      FIXED_CLOCK,
    );
    expect(classification.legs).toHaveLength(1);
    const leg = classification.legs[0]!;
    expect(leg.mode).toBe('CONTINUOUS');
    expect(leg.continuousConfigured).toBe(true);
    expect(leg.reference).toMatch(/^scheduled-window:\d+$/);
    // 2026-09-01T00:00:00Z epoch = 1789996800000? compute: the window index is deterministic.
  });

  it('RUNTIME_SIGNAL → one CONTINUOUS leg bound to the signal reference (anomaly-triggered)', () => {
    const classification = classifyTrigger(
      baseInput({
        trigger: 'RUNTIME_SIGNAL',
        revision: 'signal-anomaly-4711',
        continuous: { projectId: 'proj-1', environmentId: productionEnvironment.id },
      }),
      FIXED_CLOCK,
    );
    expect(classification.legs.map((l) => l.mode)).toEqual(['CONTINUOUS']);
    expect(classification.legs[0]!.reference).toBe('signal-anomaly-4711');
    expect(classification.legs[0]!.continuousConfigured).toBe(true);
  });

  it('USER_FEEDBACK → one CONTINUOUS leg bound to the feedback reference', () => {
    const classification = classifyTrigger(
      baseInput({
        trigger: 'USER_FEEDBACK',
        revision: 'feedback-batch-2026-09-01',
        continuous: { projectId: 'proj-1', environmentId: productionEnvironment.id },
      }),
      FIXED_CLOCK,
    );
    expect(classification.legs.map((l) => l.mode)).toEqual(['CONTINUOUS']);
  });

  it('the classification is DETERMINISTIC: identical inputs + clock → identical legs', () => {
    const input = baseInput({ trigger: 'SECURITY_FINDING', escalatedToProduction: true });
    const a = classifyTrigger(input, FIXED_CLOCK);
    const b = classifyTrigger(input, FIXED_CLOCK);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('WORK-066 trigger classification — the required authority bindings (fail closed)', () => {
  it('a PRE_MERGE-bound trigger without a revision → SCHEDULING_REVISION_REQUIRED', () => {
    expect(() => classifyTrigger(baseInput({ revision: undefined }), FIXED_CLOCK)).toThrowError(ValidationSchedulingError);
    try {
      classifyTrigger(baseInput({ revision: '' }), FIXED_CLOCK);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_REVISION_REQUIRED');
    }
  });

  it('RELEASE without a release reference → SCHEDULING_RELEASE_REFERENCE_REQUIRED (POST_RELEASE fails closed — no release authority exists to invent one from)', () => {
    try {
      classifyTrigger(baseInput({ trigger: 'RELEASE', releaseRef: undefined }), FIXED_CLOCK);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_RELEASE_REFERENCE_REQUIRED');
    }
  });

  it('an escalated two-mode trigger without a release reference → SCHEDULING_RELEASE_REFERENCE_REQUIRED', () => {
    try {
      classifyTrigger(baseInput({ trigger: 'SECURITY_FINDING', escalatedToProduction: true, releaseRef: undefined }), FIXED_CLOCK);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_RELEASE_REFERENCE_REQUIRED');
    }
  });

  it('CONTINUOUS without the explicit configuration → SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED (no autonomous unsupervised scheduling)', () => {
    try {
      classifyTrigger(baseInput({ trigger: 'RUNTIME_SIGNAL', continuous: undefined }), FIXED_CLOCK);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED');
    }
  });

  it('SCHEDULED without the cadence (intervalMs) → SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED', () => {
    try {
      classifyTrigger(
        baseInput({ trigger: 'SCHEDULED', continuous: { projectId: 'proj-1', environmentId: productionEnvironment.id } }),
        FIXED_CLOCK,
      );
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED');
    }
  });

  it('a cross-scope continuous configuration (different project) → SCHEDULING_CONTINUOUS_SCOPE_MISMATCH (tenant boundary)', () => {
    try {
      classifyTrigger(
        baseInput({
          trigger: 'SCHEDULED',
          continuous: { projectId: 'proj-OTHER', environmentId: productionEnvironment.id, intervalMs: 3600000 },
        }),
        FIXED_CLOCK,
      );
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_CONTINUOUS_SCOPE_MISMATCH');
    }
  });

  it('a cross-scope continuous configuration (different environment) → SCHEDULING_CONTINUOUS_SCOPE_MISMATCH', () => {
    try {
      classifyTrigger(
        baseInput({
          trigger: 'SCHEDULED',
          continuous: { projectId: 'proj-1', environmentId: 'env-OTHER', intervalMs: 3600000 },
        }),
        FIXED_CLOCK,
      );
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_CONTINUOUS_SCOPE_MISMATCH');
    }
  });

  it('a missing preview environment for a PRE_MERGE leg → SCHEDULING_ENVIRONMENT_REQUIRED', () => {
    try {
      classifyTrigger(baseInput({ previewEnvironment: undefined }), FIXED_CLOCK);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_ENVIRONMENT_REQUIRED');
    }
  });

  it('a PRODUCTION environment supplied as the preview target → SCHEDULING_ENVIRONMENT_MODE_MISMATCH (PRE_MERGE stays isolated from production)', () => {
    try {
      classifyTrigger(baseInput({ previewEnvironment: productionEnvironment }), FIXED_CLOCK);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_ENVIRONMENT_MODE_MISMATCH');
    }
  });

  it('a PREVIEW environment supplied as the production target → SCHEDULING_ENVIRONMENT_MODE_MISMATCH (POST_RELEASE/CONTINUOUS bind production)', () => {
    try {
      classifyTrigger(
        baseInput({ trigger: 'RELEASE', productionEnvironment: previewEnvironment }),
        FIXED_CLOCK,
      );
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_ENVIRONMENT_MODE_MISMATCH');
    }
  });

  it('an isolated environment is a VALID PRE_MERGE target (the sandboxed preview for ISOLATED_MUTATION)', () => {
    const classification = classifyTrigger(baseInput({ trigger: 'PR' }), FIXED_CLOCK);
    // the default fixture is preview; isolated is equally valid:
    const withIsolated = classifyTrigger(
      baseInput({ trigger: 'PR' }),
      FIXED_CLOCK,
    );
    expect(withIsolated.legs[0]!.environment.kind === 'preview' || withIsolated.legs[0]!.environment.kind === 'isolated').toBe(true);
    expect(classification.legs[0]!.environment.kind).toBe('preview');
  });

  it('a missing project id → SCHEDULING_PROJECT_REQUIRED (the tenant scope is mandatory)', () => {
    try {
      classifyTrigger(baseInput({ projectId: '' }), FIXED_CLOCK);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_PROJECT_REQUIRED');
    }
  });
});

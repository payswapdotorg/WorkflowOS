import { describe, it, expect } from 'vitest';

/**
 * WORK-066 — the assurance-aware journey selection: the FIXED mapping
 * (profile × mode → journey scope) until WORK-058 lands (Work Order
 * "Risk/assurance-aware selection"; lifecycle §2; adaptive-assurance §4).
 *
 * Required proofs (Work Order): a CRITICAL trigger admits the FULL journey
 * suite; a LIGHT trigger admits ONLY READ_ONLY smoke journeys; a FORBIDDEN
 * journey is NEVER selected in any profile or mode.
 */
import {
  selectJourneysForTrigger,
  requireAssuranceProfile,
  requireJourneyRegistry,
  PROFILE_MODE_POLICY_ALLOWANCE,
  ValidationSchedulingError,
  type AssuranceProfile,
  type ScheduleValidationTriggerInput,
} from '../../src/validation-scheduling/index.js';
import {
  declaredJourneys,
  smokeJourney,
  safeMutationJourney,
  isolatedMutationJourney,
  forbiddenJourney,
} from './helpers.js';

type SelectionInput = ScheduleValidationTriggerInput & {
  assurance: AssuranceProfile;
  mode: import('../../src/validation-scheduling/index.js').ValidationMode;
};

function selectionInput(
  assurance: AssuranceProfile,
  overrides: Partial<ScheduleValidationTriggerInput> = {},
): SelectionInput {
  const base: ScheduleValidationTriggerInput = {
    trigger: 'PR',
    projectId: 'proj-1',
    assurance,
    journeys: declaredJourneys,
    identitySource: { kind: 'unauthenticated' },
    revision: 'rev-abc',
  };
  return { ...base, ...overrides, assurance, mode: 'PRE_MERGE' } as SelectionInput;
}

function selectedIds(selection: readonly { journey: { id: string }; selected: boolean }[]): string[] {
  return selection.filter((s) => s.selected).map((s) => s.journey.id);
}

describe('WORK-066 assurance-aware selection — the profile × mode matrix', () => {
  it('LIGHT admits ONLY the READ_ONLY smoke journeys (a documentation PR)', () => {
    const selection = selectJourneysForTrigger(selectionInput('LIGHT'));
    expect(selectedIds(selection)).toEqual([smokeJourney.id]);
  });

  it('STANDARD admits the affected journeys at READ_ONLY or SAFE_MUTATION', () => {
    const selection = selectJourneysForTrigger(selectionInput('STANDARD'));
    expect(selectedIds(selection)).toEqual([smokeJourney.id, safeMutationJourney.id]);
  });

  it('HIGH_ASSURANCE admits the affected + integration journeys at READ_ONLY/SAFE_MUTATION/ISOLATED_MUTATION', () => {
    const selection = selectJourneysForTrigger(
      selectionInput('HIGH_ASSURANCE', { integrationJourneyIds: [isolatedMutationJourney.id] }),
    );
    expect(selectedIds(selection)).toEqual([smokeJourney.id, safeMutationJourney.id, isolatedMutationJourney.id]);
  });

  it('CRITICAL admits the FULL declared journey suite — including the ISOLATED_MUTATION journey', () => {
    const selection = selectJourneysForTrigger(
      selectionInput('CRITICAL', { affectedJourneyIds: [smokeJourney.id] }),
    );
    // CRITICAL ignores the affected scoping: the FULL suite is in scope.
    expect(selectedIds(selection)).toEqual([smokeJourney.id, safeMutationJourney.id, isolatedMutationJourney.id]);
  });

  it('a FORBIDDEN journey is NEVER selected — in ANY profile, ANY mode (FORBIDDEN is absolute)', () => {
    for (const assurance of ['LIGHT', 'STANDARD', 'HIGH_ASSURANCE', 'CRITICAL'] as const) {
      for (const mode of ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'] as const) {
        const selection = selectJourneysForTrigger({ ...selectionInput(assurance), mode });
        expect(selectedIds(selection)).not.toContain(forbiddenJourney.id);
        const forbiddenEntry = selection.find((s) => s.journey.id === forbiddenJourney.id);
        expect(forbiddenEntry?.selected).toBe(false);
      }
    }
  });

  it('the allowance matrix matches the lifecycle §2 / adaptive-assurance §4 tables exactly', () => {
    expect(PROFILE_MODE_POLICY_ALLOWANCE.LIGHT).toEqual({
      PRE_MERGE: ['READ_ONLY'],
      POST_RELEASE: [],
      CONTINUOUS: [],
    });
    expect(PROFILE_MODE_POLICY_ALLOWANCE.STANDARD).toEqual({
      PRE_MERGE: ['READ_ONLY', 'SAFE_MUTATION'],
      POST_RELEASE: ['READ_ONLY'],
      CONTINUOUS: ['READ_ONLY'],
    });
    expect(PROFILE_MODE_POLICY_ALLOWANCE.HIGH_ASSURANCE).toEqual({
      PRE_MERGE: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
      POST_RELEASE: ['READ_ONLY'],
      CONTINUOUS: ['READ_ONLY'],
    });
    expect(PROFILE_MODE_POLICY_ALLOWANCE.CRITICAL).toEqual({
      PRE_MERGE: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
      POST_RELEASE: ['READ_ONLY', 'SAFE_MUTATION'],
      CONTINUOUS: ['READ_ONLY', 'SAFE_MUTATION'],
    });
  });

  it('LIGHT × POST_RELEASE / LIGHT × CONTINUOUS select NOTHING (the (none) cells of the matrix)', () => {
    const postRelease = selectJourneysForTrigger({ ...selectionInput('LIGHT'), mode: 'POST_RELEASE' });
    expect(selectedIds(postRelease)).toEqual([]);
    const continuous = selectJourneysForTrigger({ ...selectionInput('LIGHT'), mode: 'CONTINUOUS' });
    expect(selectedIds(continuous)).toEqual([]);
  });

  it('the selection is DETERMINISTIC (identical inputs → identical selections)', () => {
    const a = selectJourneysForTrigger(selectionInput('STANDARD'));
    const b = selectJourneysForTrigger(selectionInput('STANDARD'));
    expect(JSON.stringify(a.map((s) => [s.journey.id, s.selected, s.selectionReason]))).toBe(
      JSON.stringify(b.map((s) => [s.journey.id, s.selected, s.selectionReason])),
    );
  });
});

describe('WORK-066 assurance-aware selection — the affected-surface scoping', () => {
  it('the affectedJourneyIds scope bounds LIGHT/STANDARD selection (the change\'s affected surface)', () => {
    const selection = selectJourneysForTrigger(
      selectionInput('STANDARD', { affectedJourneyIds: [safeMutationJourney.id] }),
    );
    expect(selectedIds(selection)).toEqual([safeMutationJourney.id]);
  });

  it('absent affectedJourneyIds → the full declared registry is the scope (the maximal honest scope)', () => {
    const selection = selectJourneysForTrigger(selectionInput('STANDARD'));
    expect(selectedIds(selection)).toEqual([smokeJourney.id, safeMutationJourney.id]);
  });

  it('an affectedJourneyIds reference to an UNDECLARED journey → SCHEDULING_JOURNEY_MISSING (only declared journeys are schedulable)', () => {
    try {
      selectJourneysForTrigger(selectionInput('STANDARD', { affectedJourneyIds: ['journey-NOT-DECLARED'] }));
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_JOURNEY_MISSING');
    }
  });

  it('an integrationJourneyIds reference to an UNDECLARED journey → SCHEDULING_JOURNEY_MISSING', () => {
    try {
      selectJourneysForTrigger(selectionInput('HIGH_ASSURANCE', { integrationJourneyIds: ['journey-NOT-DECLARED'] }));
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_JOURNEY_MISSING');
    }
  });

  it('a journey not allowing the target mode is excluded with an explicit reason', () => {
    // The isolated-mutation journey allows PRE_MERGE only; in CONTINUOUS it
    // must be excluded by mode even under CRITICAL.
    const selection = selectJourneysForTrigger({ ...selectionInput('CRITICAL'), mode: 'CONTINUOUS' });
    const isolated = selection.find((s) => s.journey.id === isolatedMutationJourney.id);
    expect(isolated?.selected).toBe(false);
    expect(isolated?.selectionReason).toContain('does not allow CONTINUOUS');
  });
});

describe('WORK-066 input validation (fail closed)', () => {
  it('a foreign assurance profile → SCHEDULING_ASSURANCE_INVALID', () => {
    try {
      requireAssuranceProfile('ULTRA');
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_ASSURANCE_INVALID');
    }
  });

  it('an empty journey registry → SCHEDULING_JOURNEY_REGISTRY_EMPTY', () => {
    try {
      requireJourneyRegistry([]);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as ValidationSchedulingError).code).toBe('SCHEDULING_JOURNEY_REGISTRY_EMPTY');
    }
  });
});

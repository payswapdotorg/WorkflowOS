/**
 * WORK-066 — the assurance-aware journey selection (the FIXED mapping until
 * WORK-058 lands — Work Order "Risk/assurance-aware selection": "the
 * scheduler uses a fixed mapping (trigger → assurance level → journey set)
 * declared in this Work Order"; when WORK-058 lands, selection delegates to
 * its deterministic function).
 *
 * The selection is a SCOPE FILTER over the journeys DECLARED under WORK-064's
 * authority — never a grant:
 *
 *   - LIGHT:          the affected journeys with effectPolicy READ_ONLY
 *                     (the "READ_ONLY smoke journeys");
 *   - STANDARD:       the affected journeys at READ_ONLY or SAFE_MUTATION;
 *   - HIGH_ASSURANCE: the affected + integration journeys at
 *                     READ_ONLY/SAFE_MUTATION/ISOLATED_MUTATION;
 *   - CRITICAL:       the FULL declared journey suite at
 *                     READ_ONLY/SAFE_MUTATION/ISOLATED_MUTATION;
 *   - every profile:  the journey must allow the target mode, and a
 *                     FORBIDDEN journey is NEVER selected (FORBIDDEN is
 *                     absolute — the allowance sets exclude it by
 *                     construction).
 *
 * The FINAL admission decision (environment × policy × mode × identity)
 * remains the WORK-064 gate — the scheduler only selects and requests.
 */
import type { ValidationJourney, ValidationMode, ValidationTrigger } from '../types.js';
import { AssuranceProfile, ScheduleValidationTriggerInput, ValidationSchedulingError } from '../types.js';
import { ASSURANCE_PROFILES, PROFILE_MODE_POLICY_ALLOWANCE } from '../types.js';

/** The per-journey selection decision. */
export interface JourneySelection {
  readonly journey: ValidationJourney;
  readonly selected: boolean;
  readonly selectionReason: string;
}

/** The scope-set resolution for a profile (the fixed mapping's journey-set rule). */
function scopeJourneyIds(input: ScheduleValidationTriggerInput, assurance: AssuranceProfile): Set<string> {
  const declaredIds = new Set(input.journeys.map((j) => j.id));
  const affected = input.affectedJourneyIds;
  const integration = input.integrationJourneyIds;
  const referenced: readonly (string | undefined)[] = [...(affected ?? []), ...(integration ?? [])];
  for (const id of referenced) {
    if (id !== undefined && !declaredIds.has(id)) {
      // Fail closed: the caller referenced a journey NOT declared under
      // WORK-064's authority (the scheduler admits only declared journeys).
      throw new ValidationSchedulingError(
        'SCHEDULING_JOURNEY_MISSING',
        `journey ${JSON.stringify(id)} is referenced by the trigger's scope but is NOT declared in the journey registry (the scheduler admits only journeys declared under WORK-064's authority)`,
      );
    }
  }
  if (assurance === 'CRITICAL') {
    // The FULL declared journey suite.
    return declaredIds;
  }
  if (assurance === 'HIGH_ASSURANCE') {
    // The affected + integration journeys (affected defaults to the full
    // registry when the caller does not scope).
    const scope = new Set<string>(affected ?? declaredIds);
    for (const id of integration ?? []) scope.add(id);
    return scope;
  }
  // LIGHT / STANDARD: the affected journeys (default: the full registry).
  return new Set<string>(affected ?? declaredIds);
}

/**
 * Select the journeys in scope for a mode leg under the assurance profile
 * (the deterministic fixed mapping). PURE: identical inputs → identical
 * selections.
 */
export function selectJourneysForTrigger(
  input: ScheduleValidationTriggerInput & { assurance: AssuranceProfile; mode: ValidationMode },
): readonly JourneySelection[] {
  const { assurance, mode, journeys } = input;
  const allowance = PROFILE_MODE_POLICY_ALLOWANCE[assurance][mode];
  const scope = scopeJourneyIds(input, assurance);
  const trigger: ValidationTrigger = input.trigger as ValidationTrigger;

  return journeys.map((journey) => {
    if (!scope.has(journey.id)) {
      return {
        journey,
        selected: false,
        selectionReason: `journey ${journey.id} is out of the ${assurance} scope for this trigger`,
      };
    }
    if (!journey.allowedModes.includes(mode)) {
      return {
        journey,
        selected: false,
        selectionReason: `journey ${journey.id} does not allow ${mode} (allowed: ${journey.allowedModes.join(', ')})`,
      };
    }
    if (!allowance.includes(journey.effectPolicy)) {
      return {
        journey,
        selected: false,
        selectionReason: `journey ${journey.id} (${journey.effectPolicy}) is beyond the ${assurance} × ${mode} allowance (${allowance.join(', ') || 'none'}${journey.effectPolicy === 'FORBIDDEN' ? ' — FORBIDDEN is never selected in any profile or mode' : ''})`,
      };
    }
    return {
      journey,
      selected: true,
      selectionReason: `journey ${journey.id} (${journey.effectPolicy}) is in the ${assurance} × ${mode} scope for trigger ${trigger}`,
    };
  });
}

/** Validate the assurance profile input (fail closed on foreign strings). */
export function requireAssuranceProfile(value: string): AssuranceProfile {
  if (!(ASSURANCE_PROFILES as readonly string[]).includes(value)) {
    throw new ValidationSchedulingError(
      'SCHEDULING_ASSURANCE_INVALID',
      `unknown assurance profile ${JSON.stringify(value)} (accepted: ${ASSURANCE_PROFILES.join(' | ')})`,
    );
  }
  return value as AssuranceProfile;
}

/** Validate the journey registry (non-empty — an empty registry fails closed). */
export function requireJourneyRegistry(journeys: readonly ValidationJourney[]): readonly ValidationJourney[] {
  if (!Array.isArray(journeys) || journeys.length === 0) {
    throw new ValidationSchedulingError(
      'SCHEDULING_JOURNEY_REGISTRY_EMPTY',
      'a trigger event requires a non-empty declared journey registry (the journeys declared under WORK-064\'s authority)',
    );
  }
  return journeys;
}

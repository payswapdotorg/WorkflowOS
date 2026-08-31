/**
 * WORK-065 — the browser journey plan constructor.
 *
 * THE CONTRACT (spec/work-orders/WORK-065.md;
 * spec/architecture/v1.1/validation-model.md §9.2-§9.3): the plan is the
 * execution plan derived from a {@link ValidationJourney}. It is the ordered
 * browser steps the agent performs, each action optionally satisfying one of
 * the step's declared expected observations.
 *
 * Validation (fail closed):
 *   - the plan's journeyId MUST match the journey's id;
 *   - every plan step's `stepId` MUST be a declared journey step;
 *   - every action's `satisfiesObservationId` MUST be a declared expected
 *     observation in the journey (a foreign reference is rejected);
 *   - the plan MUST satisfy at least one expected observation (a plan that
 *     observes nothing the journey declared makes health vacuous);
 *   - the plan MUST NOT reference the same expected observation twice (a
 *     duplicate result is a finalization boundary rejection — caught early
 *     here for a clearer error);
 *   - an `extract` action MUST declare a `satisfiesObservationId` (an
 *     extraction that observes nothing the journey declared is meaningless).
 */
import type { BrowserJourneyPlan, BrowserAction } from '../types.js';
import type { ValidationJourney } from '../../continuous-validation/types.js';
import { BrowserValidationError } from '../types.js';

/** A plan step input (the mutable shape the caller supplies). */
export interface BrowserPlanStepInput {
  readonly stepId: string;
  readonly actions: readonly BrowserAction[];
}

/** The input shape for {@link defineBrowserJourneyPlan}. */
export interface BrowserJourneyPlanInput {
  readonly journeyId: string;
  readonly steps: readonly BrowserPlanStepInput[];
}

/**
 * Construct a validated, immutable {@link BrowserJourneyPlan}. Throws a
 * typed {@link BrowserValidationError} on every violation:
 *
 *   - BROWSER_PLAN_INVALID — malformed plan (empty journeyId, empty steps,
 *     a step with no actions, an unknown stepId);
 *   - BROWSER_PLAN_FOREIGN_OBSERVATION — an action satisfies an observation
 *     that is not declared in the journey, or a step references an unknown
 *     step id;
 *   - BROWSER_PLAN_SATISFIES_NOTHING — the plan satisfies no declared
 *     observation (health would be vacuous), or a duplicate
 *     satisfiesObservationId appears.
 */
export function defineBrowserJourneyPlan(
  input: BrowserJourneyPlanInput,
  journey: ValidationJourney,
): BrowserJourneyPlan {
  if (!input || typeof input.journeyId !== 'string' || input.journeyId.trim() === '') {
    throw new BrowserValidationError('BROWSER_PLAN_INVALID', 'plan journeyId must be a non-empty string');
  }
  if (input.journeyId !== journey.id) {
    throw new BrowserValidationError(
      'BROWSER_PLAN_INVALID',
      `plan journeyId '${input.journeyId}' does not match journey '${journey.id}'`,
    );
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new BrowserValidationError(
      'BROWSER_PLAN_INVALID',
      `plan for journey ${journey.id} declares at least one step`,
    );
  }

  // Index the journey's step ids + expected observation ids.
  const journeyStepIds = new Set<string>();
  const journeyObservationIds = new Set<string>();
  const observationsByStep = new Map<string, Set<string>>();
  for (const step of journey.steps) {
    journeyStepIds.add(step.id);
    const obs = new Set<string>();
    for (const expected of step.expectedObservations) {
      journeyObservationIds.add(expected.id);
      obs.add(expected.id);
    }
    observationsByStep.set(step.id, obs);
  }

  const satisfiedIds = new Set<string>();
  for (const planStep of input.steps) {
    if (!planStep || typeof planStep.stepId !== 'string' || planStep.stepId.trim() === '') {
      throw new BrowserValidationError(
        'BROWSER_PLAN_INVALID',
        `plan for journey ${journey.id}: every step has a non-empty stepId`,
      );
    }
    if (!journeyStepIds.has(planStep.stepId)) {
      throw new BrowserValidationError(
        'BROWSER_PLAN_FOREIGN_OBSERVATION',
        `plan for journey ${journey.id}: step ${planStep.stepId} is not declared in the journey`,
      );
    }
    if (!Array.isArray(planStep.actions) || planStep.actions.length === 0) {
      throw new BrowserValidationError(
        'BROWSER_PLAN_INVALID',
        `plan for journey ${journey.id}: step ${planStep.stepId} declares at least one action`,
      );
    }
    const stepObs = observationsByStep.get(planStep.stepId)!;
    for (const action of planStep.actions) {
      if (!action || typeof action.kind !== 'string') {
        throw new BrowserValidationError(
          'BROWSER_PLAN_INVALID',
          `plan for journey ${journey.id}: step ${planStep.stepId} has a malformed action`,
        );
      }
      const satisfiesId = (action as { satisfiesObservationId?: unknown }).satisfiesObservationId;
      // extract MUST satisfy an observation (an extraction that observes
      // nothing the journey declared is meaningless).
      if (action.kind === 'extract' && (typeof satisfiesId !== 'string' || satisfiesId.trim() === '')) {
        throw new BrowserValidationError(
          'BROWSER_PLAN_INVALID',
          `plan for journey ${journey.id}: step ${planStep.stepId} — an extract action must declare a satisfiesObservationId`,
        );
      }
      if (satisfiesId !== undefined) {
        if (typeof satisfiesId !== 'string' || satisfiesId.trim() === '') {
          throw new BrowserValidationError(
            'BROWSER_PLAN_INVALID',
            `plan for journey ${journey.id}: step ${planStep.stepId} — satisfiesObservationId must be a non-empty string`,
          );
        }
        if (!journeyObservationIds.has(satisfiesId)) {
          throw new BrowserValidationError(
            'BROWSER_PLAN_FOREIGN_OBSERVATION',
            `plan for journey ${journey.id}: step ${planStep.stepId} satisfies '${satisfiesId}' which is not a declared expected observation`,
          );
        }
        if (!stepObs.has(satisfiesId)) {
          throw new BrowserValidationError(
            'BROWSER_PLAN_FOREIGN_OBSERVATION',
            `plan for journey ${journey.id}: step ${planStep.stepId} satisfies '${satisfiesId}' which belongs to a different step (cross-step satisfaction is rejected)`,
          );
        }
        if (satisfiedIds.has(satisfiesId)) {
          throw new BrowserValidationError(
            'BROWSER_PLAN_SATISFIES_NOTHING',
            `plan for journey ${journey.id}: step ${planStep.stepId} satisfies '${satisfiesId}' twice (a duplicate result is rejected — the finalization boundary accepts exactly one result per expectation)`,
          );
        }
        satisfiedIds.add(satisfiesId);
      }
    }
  }

  // The plan MUST satisfy at least one expected observation — otherwise
  // health would be vacuous (no observation the journey declared is captured).
  if (satisfiedIds.size === 0) {
    throw new BrowserValidationError(
      'BROWSER_PLAN_SATISFIES_NOTHING',
      `plan for journey ${journey.id} satisfies no declared expected observation — the plan observes nothing the journey declared (health would be vacuous)`,
    );
  }

  // NOTE: the plan carries NO navigation-safety allowlist (PR #97 second +
  // third + fourth architect review corrections). The authoritative allowlist
  // is the JOURNEY's own `ValidationJourney.readonlySafeNavigationTargets`
  // field (declared and validated under WORK-064's authority at
  // defineValidationJourney) — there is no plan field, no separate declaration
  // object, and no execution-input field for it. The executor constructs the
  // plan (choosing navigate actions) but CANNOT create, replace, or expand the
  // trusted safe-target set.

  return Object.freeze({
    journeyId: input.journeyId,
    steps: Object.freeze(
      input.steps.map((step) =>
        Object.freeze({
          stepId: step.stepId,
          actions: Object.freeze([...step.actions]),
        }),
      ),
    ),
  });
}

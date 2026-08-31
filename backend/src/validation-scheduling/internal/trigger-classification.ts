/**
 * WORK-066 — trigger classification: the closed-vocabulary trigger kind
 * check + the deterministic trigger → mode-leg resolution (lifecycle §3, the
 * normative TRIGGER_MODE_BINDING table owned by WORK-064).
 *
 * The scheduler CONSUMS the trigger vocabulary from the WORK-064 authority
 * (VALIDATION_TRIGGERS + TRIGGER_MODE_BINDING) — it invents no trigger kinds
 * (a foreign kind, including a hypothetical `MANUAL`, fails closed with
 * SCHEDULING_TRIGGER_UNKNOWN). Each mode leg carries its required authority
 * bindings (the revision for PRE_MERGE legs, the recorded release reference
 * for POST_RELEASE legs, the explicit continuous configuration for
 * CONTINUOUS legs) — fail closed when absent. The two-mode triggers
 * (SECURITY_FINDING, DEPENDENCY_CHANGE) bind a PRE_MERGE leg always and a
 * POST_RELEASE leg only when the subject is escalated to production.
 */
import type { Environment, ValidationMode, ValidationTrigger } from '../types.js';
import {
  ContinuousValidationConfiguration,
  ScheduleValidationTriggerInput,
  ValidationSchedulingError,
} from '../types.js';
import { VALIDATION_MODES, VALIDATION_TRIGGERS, TRIGGER_MODE_BINDING } from '../../continuous-validation/types.js';
import { evaluateContinuousWindow } from './continuous-cadence.js';
import { scheduledWindowReference } from './scheduling-identity.js';

/** The PRE_MERGE environment kinds (lifecycle §1: preview/isolated). */
const PRE_MERGE_ENVIRONMENT_KINDS: readonly string[] = ['preview', 'isolated'];

/** A resolved mode leg: the mode, its logical reference, its environment, and its admission bindings. */
export interface TriggerModeLeg {
  readonly mode: ValidationMode;
  /** The leg's target environment (already scope-checked for kind). */
  readonly environment: Environment;
  /**
   * The leg's logical reference: the revision (PRE_MERGE), the release
   * reference (POST_RELEASE), `scheduled-window:<index>` (SCHEDULED), or the
   * signal reference (event-driven CONTINUOUS).
   */
  readonly reference: string;
  /** The recorded release reference (POST_RELEASE legs only). */
  readonly releaseRef: string | undefined;
  /** Whether the WORK-064 admission request must set continuousConfigured. */
  readonly continuousConfigured: boolean;
}

/** The trigger classification: the validated kind + the resolved mode legs. */
export interface TriggerClassification {
  readonly trigger: ValidationTrigger;
  readonly legs: readonly TriggerModeLeg[];
}

function requireNonEmpty(value: string | undefined, code: 'SCHEDULING_REVISION_REQUIRED' | 'SCHEDULING_RELEASE_REFERENCE_REQUIRED', what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationSchedulingError(code, `${what} (the trigger's authority binding is REQUIRED — fail closed when absent)`);
  }
  return value;
}

function requirePreviewEnvironment(input: ScheduleValidationTriggerInput): Environment {
  const environment = input.previewEnvironment;
  if (!environment) {
    throw new ValidationSchedulingError(
      'SCHEDULING_ENVIRONMENT_REQUIRED',
      'this trigger binds a PRE_MERGE leg — a preview (or isolated) environment is REQUIRED',
    );
  }
  if (!PRE_MERGE_ENVIRONMENT_KINDS.includes(environment.kind)) {
    throw new ValidationSchedulingError(
      'SCHEDULING_ENVIRONMENT_MODE_MISMATCH',
      `PRE_MERGE binds preview/isolated environments (the supplied previewEnvironment has kind '${environment.kind}')`,
    );
  }
  return environment;
}

function requireProductionEnvironment(input: ScheduleValidationTriggerInput): Environment {
  const environment = input.productionEnvironment;
  if (!environment) {
    throw new ValidationSchedulingError(
      'SCHEDULING_ENVIRONMENT_REQUIRED',
      'this trigger binds a POST_RELEASE/CONTINUOUS leg — the production environment is REQUIRED',
    );
  }
  if (environment.kind !== 'production') {
    throw new ValidationSchedulingError(
      'SCHEDULING_ENVIRONMENT_MODE_MISMATCH',
      `POST_RELEASE/CONTINUOUS bind the production environment (the supplied productionEnvironment has kind '${environment.kind}')`,
    );
  }
  return environment;
}

function requireContinuousConfiguration(input: ScheduleValidationTriggerInput): ContinuousValidationConfiguration {
  const config = input.continuous;
  if (!config || typeof config !== 'object') {
    throw new ValidationSchedulingError(
      'SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED',
      'CONTINUOUS scheduling requires explicit configuration (lifecycle §4 — no autonomous unsupervised scheduling)',
    );
  }
  if (typeof config.projectId !== 'string' || config.projectId.trim() === '') {
    throw new ValidationSchedulingError('SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED', 'the continuous configuration requires a non-empty project scope');
  }
  if (typeof config.environmentId !== 'string' || config.environmentId.trim() === '') {
    throw new ValidationSchedulingError('SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED', 'the continuous configuration requires a non-empty environment scope');
  }
  if (config.projectId !== input.projectId) {
    throw new ValidationSchedulingError(
      'SCHEDULING_CONTINUOUS_SCOPE_MISMATCH',
      `the continuous configuration's project scope (${JSON.stringify(config.projectId)}) does not match the trigger's project (${JSON.stringify(input.projectId)}) — cross-scope continuous configuration fails closed`,
    );
  }
  const production = input.productionEnvironment;
  if (production && config.environmentId !== production.id) {
    throw new ValidationSchedulingError(
      'SCHEDULING_CONTINUOUS_SCOPE_MISMATCH',
      `the continuous configuration's environment scope (${JSON.stringify(config.environmentId)}) does not match the target production environment (${JSON.stringify(production.id)})`,
    );
  }
  return config;
}

/**
 * Classify the trigger: validate the closed vocabulary, then resolve the
 * mode legs with their required authority bindings. Every invalid input
 * fails closed with a typed SCHEDULING_* error.
 */
export function classifyTrigger(input: ScheduleValidationTriggerInput, now: () => Date): TriggerClassification {
  // The closed trigger vocabulary (WORK-064's authority — fail closed on
  // foreign kinds; the scheduler invents no trigger types).
  if (typeof input.trigger !== 'string' || !(VALIDATION_TRIGGERS as readonly string[]).includes(input.trigger)) {
    throw new ValidationSchedulingError(
      'SCHEDULING_TRIGGER_UNKNOWN',
      `unknown validation trigger ${JSON.stringify(input.trigger)} (accepted: ${VALIDATION_TRIGGERS.join(' | ')} — the scheduler consumes the closed WORK-064 vocabulary and invents none)`,
    );
  }
  const trigger = input.trigger as ValidationTrigger;

  // The project scope (the tenant boundary of the scheduling identity).
  if (typeof input.projectId !== 'string' || input.projectId.trim() === '') {
    throw new ValidationSchedulingError('SCHEDULING_PROJECT_REQUIRED', 'a trigger event requires a non-empty project id (the tenant scope)');
  }

  // The mode legs per the normative trigger → mode binding.
  const boundModes = TRIGGER_MODE_BINDING[trigger];
  const legs: TriggerModeLeg[] = [];

  const wantsPreMerge = boundModes.includes('PRE_MERGE');
  const wantsPostRelease = boundModes.includes('POST_RELEASE');
  const wantsContinuous = boundModes.includes('CONTINUOUS');

  if (wantsPreMerge) {
    // PRE_MERGE legs require the change's revision (the change identity).
    const revision = requireNonEmpty(input.revision, 'SCHEDULING_REVISION_REQUIRED', 'a PRE_MERGE-bound trigger requires the change revision');
    legs.push({
      mode: 'PRE_MERGE',
      environment: requirePreviewEnvironment(input),
      reference: revision,
      releaseRef: undefined,
      continuousConfigured: false,
    });
  }

  if (wantsPostRelease) {
    // The two-mode triggers escalate to POST_RELEASE only when the subject is
    // already in the released production deployment; the RELEASE trigger is
    // POST_RELEASE outright.
    const escalate = trigger === 'RELEASE' || input.escalatedToProduction === true;
    if (escalate) {
      const releaseRef = requireNonEmpty(input.releaseRef, 'SCHEDULING_RELEASE_REFERENCE_REQUIRED', 'a POST_RELEASE-bound trigger requires the recorded release reference');
      legs.push({
        mode: 'POST_RELEASE',
        environment: requireProductionEnvironment(input),
        reference: releaseRef,
        releaseRef,
        continuousConfigured: false,
      });
    }
  }

  if (wantsContinuous) {
    const production = requireProductionEnvironment(input);
    const config = requireContinuousConfiguration(input);
    let reference: string;
    if (trigger === 'SCHEDULED') {
      // The scheduled-interval cadence: the current window is the logical
      // reference (deterministic window math; NO catch-up for missed
      // windows — only the CURRENT window is ever scheduled).
      const intervalMs = config.intervalMs;
      if (typeof intervalMs !== 'number') {
        throw new ValidationSchedulingError(
          'SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED',
          'a SCHEDULED trigger requires the cadence (intervalMs) on the continuous configuration',
        );
      }
      const window = evaluateContinuousWindow({ intervalMs, now: now() });
      reference = scheduledWindowReference(window.windowIndex);
    } else {
      // The event-driven CONTINUOUS triggers (RUNTIME_SIGNAL, USER_FEEDBACK):
      // the signal/feedback reference is the logical identity.
      reference = requireNonEmpty(input.revision, 'SCHEDULING_REVISION_REQUIRED', `a ${trigger} trigger requires the signal/feedback reference`);
    }
    legs.push({
      mode: 'CONTINUOUS',
      environment: production,
      reference,
      releaseRef: undefined,
      continuousConfigured: true,
    });
  }

  // Defense in depth: the classification must produce at least one leg with
  // modes from the closed vocabulary (a trigger binding no leg is invalid).
  if (legs.length === 0) {
    throw new ValidationSchedulingError(
      'SCHEDULING_TRIGGER_UNKNOWN',
      `trigger ${trigger} resolved to no mode leg (binds: ${boundModes.join(', ')})`,
    );
  }
  for (const leg of legs) {
    if (!(VALIDATION_MODES as readonly string[]).includes(leg.mode)) {
      throw new ValidationSchedulingError('SCHEDULING_TRIGGER_UNKNOWN', `leg mode ${JSON.stringify(leg.mode)} is not in the closed mode vocabulary`);
    }
  }

  return { trigger, legs };
}

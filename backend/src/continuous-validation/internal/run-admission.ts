/**
 * WORK-064 Task 5 — ValidationRun admission: the deterministic composition
 * of journey/mode/trigger constraints, environment validity, effect-policy
 * admission, and identity binding (spec/work-orders/WORK-064.md;
 * lifecycle §4 "The scheduling rules"; validation-model §5).
 *
 * Admission NEVER executes anything and NEVER schedules anything: it is the
 * pure, side-effect-free gate a future executor (WORK-065) must pass
 * through. The scheduler (WORK-066) decides WHEN to request admission —
 * CONTINUOUS runs additionally require explicit configuration on the request
 * (no autonomous unsupervised scheduling), and POST_RELEASE runs require an
 * explicit release reference (repository truth: NO release authority exists
 * yet — the reference is recorded for the future authority to bind; fail
 * closed when absent).
 *
 * Architectural ruling (plan Task 5 vs repository truth): the plan lists an
 * `internal/journey.ts`, but journey DECLARATION already lives in
 * `types.ts` (`defineValidationJourney`, delivered by Task 2). The smallest
 * architecture-preserving adaptation: this file implements ONLY the
 * admission composition; no duplicate journey authority is created.
 */
import { randomUUID } from 'node:crypto';
import type {
  Environment,
  TestIdentityBinding,
  TestIdentitySource,
  ValidationJourney,
  ValidationMode,
  ValidationRun,
  ValidationTrigger,
} from '../types.js';
import { TRIGGER_MODE_BINDING, VALIDATION_MODES, VALIDATION_TRIGGERS } from '../types.js';
import { admitEffectPolicy, environmentKindValidForMode } from './effect-policy.js';
import { bindTestIdentity } from './test-identity.js';

/** The typed admission rejection codes (machine-consumable by WORK-067/068). */
export const VALIDATION_ADMISSION_ERROR_CODES = [
  'ADMISSION_MODE_INVALID',
  'ADMISSION_TRIGGER_INVALID',
  'ADMISSION_MODE_NOT_ALLOWED',
  'ADMISSION_TRIGGER_MODE_MISMATCH',
  'ADMISSION_ENVIRONMENT_MODE_MISMATCH',
  'ADMISSION_FORBIDDEN_PRODUCTION_JOURNEY',
  'ADMISSION_EFFECT_POLICY_REJECTED',
  'ADMISSION_IDENTITY_INVALID',
  'ADMISSION_RELEASE_REFERENCE_REQUIRED',
  'ADMISSION_CONTINUOUS_CONFIGURATION_REQUIRED',
] as const;
export type ValidationAdmissionErrorCode = (typeof VALIDATION_ADMISSION_ERROR_CODES)[number];

/** The admission request (everything the gate needs; nothing it may infer). */
export interface ValidationRunRequest {
  readonly journey: ValidationJourney;
  readonly identitySource: TestIdentitySource;
  readonly environment: Environment;
  readonly mode: ValidationMode;
  readonly trigger: ValidationTrigger;
  /**
   * REQUIRED for POST_RELEASE: the recorded release reference. Repository
   * truth: no release authority exists yet, so the domain cannot validate it
   * against one — it records it and fails closed when absent.
   */
  readonly releaseRef?: string;
  /**
   * REQUIRED for CONTINUOUS: explicit configuration. CONTINUOUS is never
   * admitted merely because a caller requests it (lifecycle §4: "A CONTINUOUS
   * run is admitted only by explicit configuration — no autonomous
   * unsupervised scheduling").
   */
  readonly continuousConfigured?: boolean;
  /** Deterministic run id for tests; generated when absent. */
  readonly runId?: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

/** The deterministic admission decision (echoes the request context). */
export interface ValidationRunAdmission {
  readonly admitted: boolean;
  readonly reason: string;
  readonly code: ValidationAdmissionErrorCode | 'ADMITTED';
  readonly journey: ValidationJourney;
  readonly identity: TestIdentityBinding | null;
  readonly environment: Environment;
  readonly mode: ValidationMode;
  readonly trigger: ValidationTrigger;
  /** The admitted run record (null when rejected). */
  readonly run: ValidationRun | null;
}

/**
 * Admit (or reject) a validation run. Deterministic evaluation order:
 *
 *   1. mode/trigger vocabulary (fail closed on foreign strings);
 *   2. journey.allowedModes ∋ mode;
 *   3. trigger valid for the mode (lifecycle §3 binding);
 *   4. environment kind valid for the mode (validation-model §5);
 *   5. FORBIDDEN × production journey rejected outright (defense in depth
 *      ahead of the policy matrix);
 *   6. the Task 3 effect-policy matrix (environment × policy × mode);
 *   7. identity requirement match + synthetic binding (Task 4);
 *   8. POST_RELEASE release reference / CONTINUOUS explicit configuration;
 *   9. construct the immutable admitted run.
 */
export function admitValidationRun(input: ValidationRunRequest): ValidationRunAdmission {
  const { journey, identitySource, environment, mode, trigger } = input;
  const base = {
    journey,
    identity: null as TestIdentityBinding | null,
    environment,
    mode,
    trigger,
  };

  // 1. Vocabulary (fail closed).
  if (!(VALIDATION_MODES as readonly string[]).includes(mode)) {
    return {
      ...base,
      admitted: false,
      code: 'ADMISSION_MODE_INVALID',
      reason: `unknown validation mode ${JSON.stringify(mode)} (accepted: ${VALIDATION_MODES.join(' | ')})`,
      run: null,
    };
  }
  if (!(VALIDATION_TRIGGERS as readonly string[]).includes(trigger)) {
    return {
      ...base,
      admitted: false,
      code: 'ADMISSION_TRIGGER_INVALID',
      reason: `unknown validation trigger ${JSON.stringify(trigger)} (accepted: ${VALIDATION_TRIGGERS.join(' | ')})`,
      run: null,
    };
  }

  // 2. The journey must allow the mode.
  if (!journey.allowedModes.includes(mode)) {
    return {
      ...base,
      admitted: false,
      code: 'ADMISSION_MODE_NOT_ALLOWED',
      reason: `journey ${journey.id} does not allow ${mode} (allowed: ${journey.allowedModes.join(', ')})`,
      run: null,
    };
  }

  // 3. The trigger must be valid for the mode (lifecycle §3).
  if (!TRIGGER_MODE_BINDING[trigger].includes(mode)) {
    return {
      ...base,
      admitted: false,
      code: 'ADMISSION_TRIGGER_MODE_MISMATCH',
      reason: `trigger ${trigger} does not bind ${mode} (binds: ${TRIGGER_MODE_BINDING[trigger].join(', ')})`,
      run: null,
    };
  }

  // 4. The environment kind must be valid for the mode.
  if (!environmentKindValidForMode(environment, mode)) {
    return {
      ...base,
      admitted: false,
      code: 'ADMISSION_ENVIRONMENT_MODE_MISMATCH',
      reason: `mode ${mode} cannot run against a ${environment.kind} environment (PRE_MERGE binds preview/isolated; POST_RELEASE and CONTINUOUS bind production)`,
      run: null,
    };
  }

  // 5. Defense in depth: a FORBIDDEN journey never touches production.
  if (journey.effectPolicy === 'FORBIDDEN' && environment.kind === 'production') {
    return {
      ...base,
      admitted: false,
      code: 'ADMISSION_FORBIDDEN_PRODUCTION_JOURNEY',
      reason: `journey ${journey.id} declares FORBIDDEN — dangerous functionality is never admitted against a production environment`,
      run: null,
    };
  }

  // 6. The effect-policy matrix.
  const policyDecision = admitEffectPolicy(environment, journey.effectPolicy, mode);
  if (!policyDecision.admitted) {
    return {
      ...base,
      admitted: false,
      code: 'ADMISSION_EFFECT_POLICY_REJECTED',
      reason: `journey ${journey.id} (${journey.effectPolicy}) rejected: ${policyDecision.reason}`,
      run: null,
    };
  }

  // 7. Identity requirement match + synthetic binding.
  const identityRequirementMatches =
    (journey.identityRequirement === 'unauthenticated' && identitySource.kind === 'unauthenticated') ||
    (journey.identityRequirement === 'authenticated' && identitySource.kind === 'synthetic');
  if (!identityRequirementMatches) {
    return {
      ...base,
      admitted: false,
      code: 'ADMISSION_IDENTITY_INVALID',
      reason: `journey ${journey.id} requires an ${journey.identityRequirement} identity (supplied: ${identitySource.kind})`,
      run: null,
    };
  }
  let identity: TestIdentityBinding;
  try {
    identity = bindTestIdentity(identitySource, environment, journey.effectPolicy);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'the test-identity binding was rejected';
    return {
      ...base,
      admitted: false,
      code: 'ADMISSION_IDENTITY_INVALID',
      reason,
      run: null,
    };
  }

  // 8. Mode-specific references (fail closed when absent).
  if (mode === 'POST_RELEASE' && (typeof input.releaseRef !== 'string' || input.releaseRef.trim() === '')) {
    return {
      ...base,
      identity,
      admitted: false,
      code: 'ADMISSION_RELEASE_REFERENCE_REQUIRED',
      reason:
        'POST_RELEASE admission requires an explicit release reference (no release authority exists in the repository yet — the reference is recorded for the future authority to bind)',
      run: null,
    };
  }
  if (mode === 'CONTINUOUS' && input.continuousConfigured !== true) {
    return {
      ...base,
      identity,
      admitted: false,
      code: 'ADMISSION_CONTINUOUS_CONFIGURATION_REQUIRED',
      reason:
        'CONTINUOUS admission requires explicit configuration (no autonomous unsupervised scheduling — WORK-066 owns triggers)',
      run: null,
    };
  }

  // 9. Construct the immutable admitted run.
  const now = (input.now ?? (() => new Date()))();
  const run: ValidationRun = Object.freeze({
    id: input.runId ?? `cvr_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    journeyId: journey.id,
    journeyName: journey.name,
    identity: Object.freeze({ ...identity, capabilities: Object.freeze([...identity.capabilities]) }),
    environmentId: environment.id,
    environmentKind: environment.kind,
    effectPolicy: journey.effectPolicy,
    mode,
    trigger,
    releaseRef: input.releaseRef ?? null,
    status: 'admitted',
    observations: Object.freeze([]),
    outcome: null,
    createdAt: now.toISOString(),
    completedAt: null,
  });
  return {
    admitted: true,
    reason: `run ${run.id} admitted for journey ${journey.id} (${journey.effectPolicy} × ${environment.kind} × ${mode} × ${trigger})`,
    code: 'ADMITTED',
    journey,
    identity,
    environment,
    mode,
    trigger,
    run,
  };
}

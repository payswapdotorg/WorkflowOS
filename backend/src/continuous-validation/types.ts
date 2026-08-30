/**
 * WORK-064 — Continuous Product Validation: the public domain contracts.
 *
 * The domain lives at `src/continuous-validation/` (application-layer
 * capability OUTSIDE src/modules/, mirroring the §34 benchmark /
 * execution-policy / orchestration / agent-roles pattern — NOT an 18th
 * frozen module). It CONSUMES the existing authorities through their public
 * barrels and owns ONLY the validation-domain semantics:
 *
 *   ValidationJourney / ValidationRun / TestIdentity / Environment /
 *   EffectPolicy / ExpectedObservation / typed ValidationOutcome.
 *
 * BOUNDARY CONTRACT (spec/work-orders/WORK-064.md + the repository mapping
 * note — enforced by static-architecture checks):
 *
 *   - NOT a second identity authority: TestIdentity BINDS an already
 *     authenticated `AuthenticatedPrincipal` (the /auth module's result
 *     type). It never issues credentials, never creates users, never
 *     impersonates humans. Synthetic machine principals only.
 *   - NOT a second verification/evidence authority: validation evidence
 *     REFERENCES rows in the existing /verification module; no
 *     `validation_evidence` store exists here.
 *   - NOT an execution authority: browser execution is WORK-065 (a future
 *     CONSUMER of these contracts).
 *   - NOT a scheduler: triggers are recorded, never fired. WORK-066 owns
 *     scheduling. No timers, no queues, no autonomous loops.
 *   - NO silent-healthy: every failure is a typed outcome with full
 *     provenance (run → journey → step → environment). A missing
 *     observation is an explicit validation_failure, never healthy.
 *   - Fail-closed admission: FORBIDDEN is never executable merely because
 *     a caller requests it; unknown/ambiguous environment capabilities are
 *     rejected.
 *
 * v1.0 remains frozen; this is v1.1-proposed runtime under WORK-064.
 */
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';

// ============================================================================
// §1  The closed vocabularies (spec/work-orders/WORK-064.md)
// ============================================================================

/**
 * The side-effect classification binding a validation run — the load-bearing
 * safety invariant of this Work Order.
 *
 *   READ_ONLY          — observes state, performs no mutation.
 *   SAFE_MUTATION      — mutates only state the synthetic identity owns.
 *   ISOLATED_MUTATION  — mutates state inside an isolated test tenant/sandbox.
 *   FORBIDDEN          — the action is forbidden in synthetic runs in this
 *                        environment (production destructive operations, real
 *                        payments, uncontrolled external integrations).
 */
export const EFFECT_POLICIES = [
  'READ_ONLY',
  'SAFE_MUTATION',
  'ISOLATED_MUTATION',
  'FORBIDDEN',
] as const;
export type EffectPolicy = (typeof EFFECT_POLICIES)[number];

/** The three operating modes (spec/architecture/v1.1/continuous-validation-lifecycle.md). */
export const VALIDATION_MODES = ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'] as const;
export type ValidationMode = (typeof VALIDATION_MODES)[number];

/** The nine validation triggers (the lifecycle §3 trigger→mode binding). */
export const VALIDATION_TRIGGERS = [
  'PR',
  'DEPLOYMENT',
  'RELEASE',
  'SCHEDULED',
  'RUNTIME_SIGNAL',
  'ARCHITECTURE_CHANGE',
  'SECURITY_FINDING',
  'DEPENDENCY_CHANGE',
  'USER_FEEDBACK',
] as const;
export type ValidationTrigger = (typeof VALIDATION_TRIGGERS)[number];

/**
 * The typed run outcome. `healthy` is ONLY derivable from every declared
 * success criterion being satisfied by matched observations — never from the
 * absence of records (the no-false-healthy invariant).
 */
export const VALIDATION_OUTCOME_KINDS = [
  'healthy',
  'validation_failure',
  'effect_policy_violation',
  'environment_error',
] as const;
export type ValidationOutcomeKind = (typeof VALIDATION_OUTCOME_KINDS)[number];

/** The observation channels an expectation may target. */
export const OBSERVATION_KINDS = [
  'dom',
  'network',
  'persisted_record',
  'downstream_event',
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** The deployment kinds a run may execute against. */
export const ENVIRONMENT_KINDS = ['preview', 'isolated', 'production'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/**
 * The closed synthetic principal classification. `unauthenticated` is the
 * null identity (public paths only); every other class is a SYNTHETIC test
 * principal issued under the existing identity authority — never a real
 * production user.
 */
export const TEST_PRINCIPAL_CLASSES = [
  'unauthenticated',
  'test_user',
  'test_service_account',
  'test_organization_owner',
  'test_project_member',
] as const;
export type TestPrincipalClass = (typeof TEST_PRINCIPAL_CLASSES)[number];

/** The synthetic (non-interactive machine) principal classes. */
export const SYNTHETIC_PRINCIPAL_CLASSES: readonly Exclude<TestPrincipalClass, 'unauthenticated'>[] =
  ['test_user', 'test_service_account', 'test_organization_owner', 'test_project_member'];

/**
 * The journey's identity requirement: `unauthenticated` (public surface) or
 * `authenticated` (requires a synthetic principal bound at admission).
 */
export const IDENTITY_REQUIREMENTS = ['unauthenticated', 'authenticated'] as const;
export type IdentityRequirement = (typeof IDENTITY_REQUIREMENTS)[number];

/**
 * The trigger → mode binding (lifecycle §3, the normative table). A run's
 * trigger must be valid for its mode — e.g. RELEASE only ever lands in
 * POST_RELEASE; SCHEDULED only in CONTINUOUS.
 */
export const TRIGGER_MODE_BINDING: Readonly<Record<ValidationTrigger, readonly ValidationMode[]>> = {
  PR: ['PRE_MERGE'],
  DEPLOYMENT: ['PRE_MERGE'],
  RELEASE: ['POST_RELEASE'],
  SCHEDULED: ['CONTINUOUS'],
  RUNTIME_SIGNAL: ['CONTINUOUS'],
  ARCHITECTURE_CHANGE: ['PRE_MERGE'],
  SECURITY_FINDING: ['PRE_MERGE', 'POST_RELEASE'],
  DEPENDENCY_CHANGE: ['PRE_MERGE', 'POST_RELEASE'],
  USER_FEEDBACK: ['CONTINUOUS'],
};

// ============================================================================
// §2  Environment — the deployment + its explicit policy envelope
// ============================================================================

/**
 * The deployment a validation run executes against. An environment is
 * authorized to accept ONLY the effect policies it EXPLICITLY declares in
 * `acceptedPolicies` — admission is fail-closed on everything else
 * (unknown/ambiguous capability never admits).
 */
export interface Environment {
  readonly id: string;
  readonly kind: EnvironmentKind;
  /**
   * The ONLY source of admission truth: the effect policies this environment
   * is explicitly authorized to accept. Members ⊆ EFFECT_POLICIES, non-empty.
   */
  readonly acceptedPolicies: readonly EffectPolicy[];
  /**
   * The isolated test tenant this environment binds. REQUIRED (non-empty)
   * whenever `acceptedPolicies` includes ISOLATED_MUTATION — an isolated
   * mutation without a tenant binding is structurally unrepresentable.
   */
  readonly isolatedTenantId: string | null;
  /**
   * True ONLY when an explicitly architect-approved safe mechanism exists
   * for otherwise-forbidden effects in this environment (e.g. an approved
   * test payment instrument, a controlled test double). FORBIDDEN can never
   * be admitted without this flag AND explicit FORBIDDEN acceptance.
   */
  readonly approvedSafeMechanism: boolean;
}

/** The input shape for {@link describeEnvironment} (validated at runtime). */
export interface EnvironmentInput {
  readonly id: string;
  readonly kind: EnvironmentKind;
  readonly acceptedPolicies: readonly EffectPolicy[];
  readonly isolatedTenantId?: string | null;
  readonly approvedSafeMechanism?: boolean;
}

// ============================================================================
// §3  ExpectedObservation — the deterministic expectation contract
// ============================================================================

/**
 * The deterministic match rule an observation is evaluated against. A closed
 * set — there is no "anything goes" matcher.
 */
export type ObservationMatcher =
  /** Deep structural equality with the expected value. */
  | { readonly kind: 'equals'; readonly value: unknown }
  /** The observation must EXIST (a missing observation never matches). */
  | { readonly kind: 'exists' }
  /** The observed value (string) must contain the expected substring. */
  | { readonly kind: 'contains_text'; readonly text: string }
  /** A network observation's status code must equal the expected value. */
  | { readonly kind: 'status_code'; readonly status: number };

/**
 * What a run expects to observe at a step. An expectation that is not
 * matched is never a silent pass: when a run fails, every unmet expectation
 * is recorded with full provenance, and whether an unmet expectation fails
 * the RUN is decided by the journey's declared success criteria
 * (`SuccessCriterion.requiresObservationIds` — the set that determines
 * health; expectations outside it are observational).
 */
export interface ExpectedObservation {
  readonly id: string;
  /** Must equal the owning step's id (validated at journey construction). */
  readonly stepId: string;
  readonly kind: ObservationKind;
  readonly description: string;
  readonly matcher: ObservationMatcher;
}

/** A journey step: an ordered action plus its expected observations. */
export interface ValidationStep {
  readonly id: string;
  readonly name: string;
  readonly expectedObservations: readonly ExpectedObservation[];
}

/**
 * A condition the run must satisfy to be recorded healthy. Satisfied iff
 * EVERY referenced expected observation matched. The union of all criteria's
 * `requiresObservationIds` is the set that determines run health — an
 * expectation not referenced by any criterion is observational and does not
 * fail the run.
 */
export interface SuccessCriterion {
  readonly id: string;
  readonly description: string;
  readonly requiresObservationIds: readonly string[];
}

// ============================================================================
// §4  ValidationJourney — the declaration
// ============================================================================

/**
 * A meaningful user workflow declaration owned by WORK-064 and consumed by
 * WORK-065's browser agent (the execution mechanism — never an authority).
 */
export interface ValidationJourney {
  readonly id: string;
  readonly name: string;
  readonly identityRequirement: IdentityRequirement;
  /** The operating modes this journey is admitted in (non-empty ⊆ closed set). */
  readonly allowedModes: readonly ValidationMode[];
  /** EXACTLY ONE declared effect policy per journey (Work Order invariant 1). */
  readonly effectPolicy: EffectPolicy;
  readonly steps: readonly ValidationStep[];
  readonly successCriteria: readonly SuccessCriterion[];
}

/** The input shape for {@link defineValidationJourney} (validated at runtime). */
export interface ValidationJourneyInput {
  readonly id: string;
  readonly name: string;
  readonly identityRequirement: IdentityRequirement;
  readonly allowedModes: readonly ValidationMode[];
  readonly effectPolicy: EffectPolicy;
  readonly steps: readonly ValidationStep[];
  readonly successCriteria: readonly SuccessCriterion[];
}

// ============================================================================
// §5  TestIdentity — the bound synthetic principal (NOT an identity authority)
// ============================================================================

/**
 * The synthetic principal binding. `issuer: 'WORK-063'` is the provenance
 * marker of the identity-and-access architecture decision: synthetic test
 * principals are scoped machine credentials under the identity layer's
 * authority — this binding VALIDATES and RECORDS, it never mints.
 */
export interface TestIdentityBinding {
  /** The existing authority's principal id (null ONLY for unauthenticated). */
  readonly principalId: string | null;
  readonly principalClass: TestPrincipalClass;
  /** Preserved EXACTLY as declared — the binding never expands scope. */
  readonly capabilities: readonly string[];
  /** The test tenant binding (mandatory for ISOLATED_MUTATION runs). */
  readonly tenantId: string | null;
  readonly issuer: 'WORK-063';
  /** Non-null for every synthetic class; null only for unauthenticated. */
  readonly issuanceReason: string | null;
}

/**
 * The identity source presented to admission: the unauthenticated visitor, or
 * an ALREADY-AUTHENTICATED principal (the existing /auth authority's result)
 * together with its synthetic classification. There is no path that mints a
 * credential here.
 */
export type TestIdentitySource =
  | { readonly kind: 'unauthenticated' }
  | {
      readonly kind: 'synthetic';
      /** The principal as authenticated by the EXISTING identity authority. */
      readonly principal: AuthenticatedPrincipal;
      readonly principalClass: Exclude<TestPrincipalClass, 'unauthenticated'>;
      readonly capabilities: readonly string[];
      readonly tenantId?: string;
      readonly issuanceReason: string;
    };

// ============================================================================
// §6  Observations — raw captured values with full provenance
// ============================================================================

/** The provenance every observation and failure carries. */
export interface ObservationProvenance {
  readonly runId: string;
  readonly journeyId: string;
  readonly stepId: string;
  readonly environmentId: string;
  readonly observedAt: string;
}

/** A single raw observation captured by a run. */
export interface ValidationObservation {
  readonly id: string;
  readonly kind: ObservationKind;
  readonly value: unknown;
  readonly provenance: ObservationProvenance;
}

/** The input shape for {@link recordObservation} (validated at runtime). */
export interface RecordObservationInput {
  readonly id: string;
  readonly kind: ObservationKind;
  readonly value: unknown;
  readonly provenance: ObservationProvenance;
}

/**
 * The evaluated pairing of an expected observation with the actual captured
 * observation (null when missing). Produced by the evaluation boundary and
 * consumed by finalization. The `expected` MUST quote the journey's canonical
 * declaration exactly (structural equality on id/stepId/kind/description/
 * matcher): finalization verifies it against the journey — a variant with
 * the same id but a different matcher can never produce a healthy result.
 *
 * `matched` is an executor ASSERTION, never a determination: finalization
 * independently recomputes the match with the deterministic evaluator
 * (`evaluateObservation`: canonical expectation × actual observation) and
 * REJECTS a result whose asserted `matched` contradicts the derived value.
 * Health and failure flow from the DERIVED evaluation only.
 */
export interface ObservationResult {
  readonly expected: ExpectedObservation;
  readonly actual: ValidationObservation | null;
  readonly matched: boolean;
  readonly provenance: ObservationProvenance;
}

/**
 * An execution-level error reported by the (future) executor at finalization:
 * a detected effect-policy violation, or environment/deployment
 * unavailability. Both map to their typed outcomes — never to healthy.
 */
export type ExecutionError =
  | { readonly kind: 'effect_policy_violation'; readonly reason: string }
  | { readonly kind: 'environment_error'; readonly reason: string };

// ============================================================================
// §7  Outcomes — the typed, provenance-preserving results
// ============================================================================

/** The run-level provenance carried by every typed outcome. */
export interface RunProvenance {
  readonly runId: string;
  readonly journeyId: string;
  readonly environmentId: string;
  readonly mode: ValidationMode;
  readonly trigger: ValidationTrigger;
}

/**
 * A single failed expectation: the expected observation, the actual
 * observation (null when the observation is MISSING — an explicit failure,
 * never healthy), and the full provenance.
 */
export interface ValidationFailure {
  readonly kind: 'validation_failure';
  readonly failedStepId: string;
  readonly expected: ExpectedObservation;
  readonly actual: ValidationObservation | null;
  readonly provenance: ObservationProvenance;
}

/** The typed validation outcome (discriminated by `kind`). */
export type ValidationOutcome =
  | {
      readonly kind: 'healthy';
      readonly provenance: RunProvenance;
      /** The criteria proven satisfied (healthy requires ALL declared criteria). */
      readonly satisfiedCriteria: readonly string[];
    }
  | {
      readonly kind: 'validation_failure';
      readonly provenance: RunProvenance;
      readonly failures: readonly ValidationFailure[];
    }
  | {
      readonly kind: 'effect_policy_violation';
      readonly provenance: RunProvenance;
      readonly reason: string;
    }
  | {
      readonly kind: 'environment_error';
      readonly provenance: RunProvenance;
      readonly reason: string;
    };

// ============================================================================
// §8  ValidationRun — the immutable execution record
// ============================================================================

export const VALIDATION_RUN_STATUSES = ['admitted', 'completed'] as const;
export type ValidationRunStatus = (typeof VALIDATION_RUN_STATUSES)[number];

/**
 * One synthetic execution of a ValidationJourney under a specific
 * Environment. Immutable; the outcome is null until completion and is only
 * derivable through the finalize boundary (never from missing records).
 */
export interface ValidationRun {
  readonly id: string;
  readonly journeyId: string;
  readonly journeyName: string;
  readonly identity: TestIdentityBinding;
  readonly environmentId: string;
  readonly environmentKind: EnvironmentKind;
  readonly effectPolicy: EffectPolicy;
  readonly mode: ValidationMode;
  readonly trigger: ValidationTrigger;
  /** The recorded release reference (required for POST_RELEASE admission). */
  readonly releaseRef: string | null;
  readonly status: ValidationRunStatus;
  readonly observations: readonly ValidationObservation[];
  /** Null until the run is finalized; then one of the four typed outcomes. */
  readonly outcome: ValidationOutcome | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/**
 * The persistence port for validation runs.
 *
 * ARCHITECTURAL RULING (the repository mapping note §3 + the design doc §8):
 * repository inspection proved NO existing table represents validation state,
 * and NO schema migration is authorized by WORK-064's current scope. The
 * domain therefore stays at the existing persistence boundary: this PORT with
 * an IN-MEMORY implementation. Durable validation state requires an ACR or
 * an architect-authorized scope extension. The port is the future binding
 * point for that decision — NOT a parallel evidence/identity store.
 */
export interface ValidationRunRepository {
  /**
   * Store a run. Idempotent for identical records (same-key convergence);
   * a same-id/different-content create is a typed conflict. Rejects
   * secret-shaped fields at the boundary (defense in depth).
   */
  create(run: ValidationRun): Promise<ValidationRun>;
  /** Read a run by id. Returns null when absent — never a fabricated run. */
  getById(id: string): Promise<ValidationRun | null>;
}

// ============================================================================
// §9  The typed domain error
// ============================================================================

export const CONTINUOUS_VALIDATION_ERROR_CODES = [
  // Declaration guards (Task 2)
  'VALIDATION_JOURNEY_INVALID',
  'ENVIRONMENT_INVALID',
  // Identity binding (Task 4)
  'TEST_IDENTITY_INVALID',
  'TEST_IDENTITY_HUMAN_PRINCIPAL_REJECTED',
  'TEST_IDENTITY_TENANT_REQUIRED',
  // Observation/outcome boundaries (Task 6)
  'OBSERVATION_PROVENANCE_INVALID',
  'FINALIZE_RESULTS_FOREIGN',
  'FINALIZE_EXPECTATION_CANONICAL_MISMATCH',
  'FINALIZE_MATCH_ASSERTION_MISMATCH',
  'FINALIZE_RUN_ALREADY_COMPLETED',
  'FINALIZE_JOURNEY_MISMATCH',
  'FINALIZE_EXECUTION_ERROR_INVALID',
  // Persistence port (Task 8)
  'VALIDATION_RUN_CONFLICT',
  'VALIDATION_RUN_SECRET_REJECTED',
] as const;
export type ContinuousValidationErrorCode = (typeof CONTINUOUS_VALIDATION_ERROR_CODES)[number];

/** The typed domain error (discriminated by `code`). */
export class ValidationDomainError extends Error {
  readonly code: ContinuousValidationErrorCode;

  constructor(code: ContinuousValidationErrorCode, message: string) {
    super(`continuous-validation: ${message}`);
    this.name = 'ValidationDomainError';
    this.code = code;
  }
}

// ============================================================================
// §10  Runtime constructor/guards (the declaration boundary)
// ============================================================================

function isEffectPolicy(value: unknown): value is EffectPolicy {
  return typeof value === 'string' && (EFFECT_POLICIES as readonly string[]).includes(value);
}

function isValidationMode(value: unknown): value is ValidationMode {
  return typeof value === 'string' && (VALIDATION_MODES as readonly string[]).includes(value);
}

function isObservationKind(value: unknown): value is ObservationKind {
  return typeof value === 'string' && (OBSERVATION_KINDS as readonly string[]).includes(value);
}

function isObservationMatcher(value: unknown): value is ObservationMatcher {
  if (typeof value !== 'object' || value === null) return false;
  const matcher = value as { kind?: unknown };
  switch (matcher.kind) {
    case 'equals':
      return 'value' in (matcher as Record<string, unknown>);
    case 'exists':
      return true;
    case 'contains_text':
      return typeof (matcher as { text?: unknown }).text === 'string';
    case 'status_code':
      return typeof (matcher as { status?: unknown }).status === 'number';
    default:
      return false;
  }
}

/**
 * Construct a validated, immutable {@link ValidationJourney}. Rejects empty
 * identifiers/names, invalid vocabularies, duplicate step ids, expected
 * observations whose stepId does not match their owning step, invalid
 * matchers, and success criteria referencing unknown observations.
 */
export function defineValidationJourney(input: ValidationJourneyInput): ValidationJourney {
  if (!input || typeof input.id !== 'string' || input.id.trim() === '') {
    throw new ValidationDomainError('VALIDATION_JOURNEY_INVALID', 'journey id must be a non-empty string');
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new ValidationDomainError('VALIDATION_JOURNEY_INVALID', `journey ${input.id}: name must be a non-empty string`);
  }
  if (!isEffectPolicy(input.effectPolicy)) {
    throw new ValidationDomainError(
      'VALIDATION_JOURNEY_INVALID',
      `journey ${input.id}: effectPolicy must be one of ${EFFECT_POLICIES.join(' | ')}`,
    );
  }
  if (!Array.isArray(input.allowedModes) || input.allowedModes.length === 0) {
    throw new ValidationDomainError(
      'VALIDATION_JOURNEY_INVALID',
      `journey ${input.id}: allowedModes must be a non-empty array`,
    );
  }
  for (const mode of input.allowedModes) {
    if (!isValidationMode(mode)) {
      throw new ValidationDomainError(
        'VALIDATION_JOURNEY_INVALID',
        `journey ${input.id}: invalid allowedModes member ${JSON.stringify(mode)}`,
      );
    }
  }
  if (input.identityRequirement !== 'unauthenticated' && input.identityRequirement !== 'authenticated') {
    throw new ValidationDomainError(
      'VALIDATION_JOURNEY_INVALID',
      `journey ${input.id}: identityRequirement must be 'unauthenticated' | 'authenticated'`,
    );
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new ValidationDomainError(
      'VALIDATION_JOURNEY_INVALID',
      `journey ${input.id}: a journey declares at least one step`,
    );
  }
  const stepIds = new Set<string>();
  const observationIds = new Set<string>();
  for (const step of input.steps) {
    if (!step || typeof step.id !== 'string' || step.id.trim() === '') {
      throw new ValidationDomainError(
        'VALIDATION_JOURNEY_INVALID',
        `journey ${input.id}: every step has a non-empty id`,
      );
    }
    if (typeof step.name !== 'string' || step.name.trim() === '') {
      throw new ValidationDomainError(
        'VALIDATION_JOURNEY_INVALID',
        `journey ${input.id}: step ${step.id} has a non-empty name`,
      );
    }
    if (stepIds.has(step.id)) {
      throw new ValidationDomainError(
        'VALIDATION_JOURNEY_INVALID',
        `journey ${input.id}: duplicate step id ${step.id}`,
      );
    }
    stepIds.add(step.id);
    if (!Array.isArray(step.expectedObservations)) {
      throw new ValidationDomainError(
        'VALIDATION_JOURNEY_INVALID',
        `journey ${input.id}: step ${step.id} declares its expectedObservations`,
      );
    }
    for (const expected of step.expectedObservations) {
      if (!expected || typeof expected.id !== 'string' || expected.id.trim() === '') {
        throw new ValidationDomainError(
          'VALIDATION_JOURNEY_INVALID',
          `journey ${input.id}: step ${step.id} has expected observations with non-empty ids`,
        );
      }
      if (observationIds.has(expected.id)) {
        throw new ValidationDomainError(
          'VALIDATION_JOURNEY_INVALID',
          `journey ${input.id}: duplicate expected observation id ${expected.id}`,
        );
      }
      observationIds.add(expected.id);
      if (expected.stepId !== step.id) {
        throw new ValidationDomainError(
          'VALIDATION_JOURNEY_INVALID',
          `journey ${input.id}: expected observation ${expected.id} declares stepId ${expected.stepId} but belongs to step ${step.id}`,
        );
      }
      if (!isObservationKind(expected.kind)) {
        throw new ValidationDomainError(
          'VALIDATION_JOURNEY_INVALID',
          `journey ${input.id}: expected observation ${expected.id} has invalid kind ${JSON.stringify(expected.kind)}`,
        );
      }
      if (!isObservationMatcher(expected.matcher)) {
        throw new ValidationDomainError(
          'VALIDATION_JOURNEY_INVALID',
          `journey ${input.id}: expected observation ${expected.id} has an invalid matcher`,
        );
      }
    }
  }
  if (!Array.isArray(input.successCriteria) || input.successCriteria.length === 0) {
    throw new ValidationDomainError(
      'VALIDATION_JOURNEY_INVALID',
      `journey ${input.id}: a journey declares at least one success criterion`,
    );
  }
  for (const criterion of input.successCriteria) {
    if (!criterion || typeof criterion.id !== 'string' || criterion.id.trim() === '') {
      throw new ValidationDomainError(
        'VALIDATION_JOURNEY_INVALID',
        `journey ${input.id}: every success criterion has a non-empty id`,
      );
    }
    if (!Array.isArray(criterion.requiresObservationIds) || criterion.requiresObservationIds.length === 0) {
      throw new ValidationDomainError(
        'VALIDATION_JOURNEY_INVALID',
        `journey ${input.id}: success criterion ${criterion.id} requires at least one observation`,
      );
    }
    for (const observationId of criterion.requiresObservationIds) {
      if (!observationIds.has(observationId)) {
        throw new ValidationDomainError(
          'VALIDATION_JOURNEY_INVALID',
          `journey ${input.id}: success criterion ${criterion.id} references unknown observation ${observationId}`,
        );
      }
    }
  }
  return Object.freeze({
    ...input,
    steps: Object.freeze(input.steps.map((step) => Object.freeze({ ...step }))),
    successCriteria: Object.freeze(input.successCriteria.map((c) => Object.freeze({ ...c }))),
  });
}

/**
 * Construct a validated, immutable {@link Environment}. Rejects empty ids,
 * invalid kinds, empty/invalid capability sets, and ISOLATED_MUTATION
 * acceptance without the isolated test tenant binding.
 */
export function describeEnvironment(input: EnvironmentInput): Environment {
  if (!input || typeof input.id !== 'string' || input.id.trim() === '') {
    throw new ValidationDomainError('ENVIRONMENT_INVALID', 'environment id must be a non-empty string');
  }
  if (
    input.kind !== 'preview' &&
    input.kind !== 'isolated' &&
    input.kind !== 'production'
  ) {
    throw new ValidationDomainError(
      'ENVIRONMENT_INVALID',
      `environment ${input.id}: kind must be one of ${ENVIRONMENT_KINDS.join(' | ')}`,
    );
  }
  if (!Array.isArray(input.acceptedPolicies) || input.acceptedPolicies.length === 0) {
    throw new ValidationDomainError(
      'ENVIRONMENT_INVALID',
      `environment ${input.id}: acceptedPolicies must be a non-empty array (fail-closed: no capability, no admission)`,
    );
  }
  for (const policy of input.acceptedPolicies) {
    if (!isEffectPolicy(policy)) {
      throw new ValidationDomainError(
        'ENVIRONMENT_INVALID',
        `environment ${input.id}: invalid acceptedPolicies member ${JSON.stringify(policy)}`,
      );
    }
  }
  if (
    input.acceptedPolicies.includes('ISOLATED_MUTATION') &&
    (typeof input.isolatedTenantId !== 'string' || input.isolatedTenantId.trim() === '')
  ) {
    throw new ValidationDomainError(
      'ENVIRONMENT_INVALID',
      `environment ${input.id}: accepting ISOLATED_MUTATION requires the isolated test tenant binding`,
    );
  }
  return Object.freeze({
    id: input.id,
    kind: input.kind,
    acceptedPolicies: Object.freeze([...input.acceptedPolicies]),
    isolatedTenantId: input.isolatedTenantId ?? null,
    approvedSafeMechanism: input.approvedSafeMechanism === true,
  });
}

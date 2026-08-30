/**
 * WORK-064 — Continuous Product Validation (public barrel).
 *
 * The domain/model authority for continuous product validation. It lives at
 * `src/continuous-validation/` (application-layer capability OUTSIDE
 * src/modules/ — the §34 benchmark / execution-policy / orchestration
 * precedent; NOT the 18th frozen module) and CONSUMES the existing
 * authorities:
 *
 *   - identity: `/auth` (AuthenticatedPrincipal — bound, never minted here);
 *   - verification/evidence: `/verification` (validation evidence references
 *     its Evidence rows — no parallel evidence store);
 *   - persistence: the ValidationRunRepository PORT (in-memory in this Work
 *     Order — NO schema migration is authorized; see the repository mapping
 *     note);
 *   - composition: `buildApp` constructs the service and exposes it on
 *     AppDeps for FUTURE consumers (WORK-065 browser agent, WORK-066
 *     scheduler).
 *
 * WORK-065 (browser execution), WORK-066 (scheduling), WORK-067 (signals),
 * WORK-068 (feedback conversion), WORK-069 (progressive release), and
 * WORK-070 (architecture fitness) are NOT implemented here. They are future
 * CONSUMERS of these contracts.
 */
export {
  // §1 vocabularies
  EFFECT_POLICIES,
  VALIDATION_MODES,
  VALIDATION_TRIGGERS,
  VALIDATION_OUTCOME_KINDS,
  OBSERVATION_KINDS,
  ENVIRONMENT_KINDS,
  TEST_PRINCIPAL_CLASSES,
  SYNTHETIC_PRINCIPAL_CLASSES,
  IDENTITY_REQUIREMENTS,
  TRIGGER_MODE_BINDING,
  VALIDATION_RUN_STATUSES,
  // §10 constructors
  defineValidationJourney,
  describeEnvironment,
  // errors
  ValidationDomainError,
  CONTINUOUS_VALIDATION_ERROR_CODES,
} from './types.js';
export {
  // Task 3 — fail-closed effect-policy admission
  admitEffectPolicy,
  environmentKindValidForMode,
} from './internal/effect-policy.js';
export type { EffectPolicyDecision } from './internal/effect-policy.js';
export {
  // Task 4 — test-identity binding (adapter over the /auth authority)
  bindTestIdentity,
  SYNTHETIC_IDENTITY_PROVIDERS,
} from './internal/test-identity.js';
export {
  // Task 5 — validation-run admission (the composition gate)
  admitValidationRun,
  VALIDATION_ADMISSION_ERROR_CODES,
} from './internal/run-admission.js';
export type {
  ValidationRunRequest,
  ValidationRunAdmission,
  ValidationAdmissionErrorCode,
} from './internal/run-admission.js';
export {
  // Task 6 — observations + typed outcomes with provenance
  recordObservation,
  evaluateObservation,
} from './internal/observation.js';
export {
  finalizeValidationRun,
} from './internal/outcome.js';
export type { FinalizeValidationRunInput } from './internal/outcome.js';
export {
  // Task 7 — evidence mapping into the EXISTING /verification authority
  mapValidationOutcomeToVerification,
  outcomeToEvidenceResult,
} from './internal/evidence-mapping.js';
export type {
  ValidationEvidenceReference,
  MapValidationOutcomeToVerificationInput,
} from './internal/evidence-mapping.js';
export {
  // Task 8 — the persistence port (in-memory adapter; NO migration authorized)
  InMemoryValidationRunRepository,
} from './internal/in-memory-validation-run-repository.js';
export {
  // Task 9 — the domain service composed through buildApp for future consumers
  DefaultContinuousValidationService,
} from './internal/continuous-validation-service.js';
export type {
  ContinuousValidationService,
  ContinuousValidationServiceDeps,
} from './internal/continuous-validation-service.js';
export type {
  EffectPolicy,
  ValidationMode,
  ValidationTrigger,
  ValidationOutcomeKind,
  ObservationKind,
  EnvironmentKind,
  TestPrincipalClass,
  IdentityRequirement,
  Environment,
  EnvironmentInput,
  ObservationMatcher,
  ExpectedObservation,
  ValidationStep,
  SuccessCriterion,
  ValidationJourney,
  ValidationJourneyInput,
  TestIdentityBinding,
  TestIdentitySource,
  ObservationProvenance,
  RecordObservationInput,
  ValidationObservation,
  ObservationResult,
  ExecutionError,
  RunProvenance,
  ValidationFailure,
  ValidationOutcome,
  ValidationRun,
  ValidationRunStatus,
  ValidationRunRepository,
  ContinuousValidationErrorCode,
} from './types.js';

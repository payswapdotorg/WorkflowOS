/**
 * WORK-066 — Validation Scheduling & Change Triggers (public barrel).
 *
 * The scheduler lives at `src/validation-scheduling/` (application-layer
 * capability OUTSIDE src/modules/ — the §34 benchmark / execution-policy /
 * orchestration / agent-roles / continuous-validation / browser-validation
 * precedent; NOT the 18th frozen module) and CONSUMES the existing
 * authorities:
 *
 *   - validation admission: `../continuous-validation/` (the WORK-064
 *     authority — admitRun is THE gate; the scheduler selects and requests,
 *     it never admits, finalizes, or evaluates itself);
 *   - the trigger vocabulary: WORK-064's VALIDATION_TRIGGERS +
 *     TRIGGER_MODE_BINDING (the lifecycle §3 normative table — the scheduler
 *     invents no trigger kinds);
 *   - deduplication: the ScheduledTriggerClaimStore PORT (in-memory adapter
 *     in this Work Order — NO schema migration is authorized; the durable
 *     binding point is documented, and the PostgreSQL contract is proven by
 *     the real-PG two-actor integration suite);
 *   - composition: `buildApp` constructs the scheduler and exposes it on
 *     AppDeps for future consumers (the runtime drive surfaces — a governed
 *     job handler, the dogfooding experiment — are FUTURE decisions; this
 *     Work Order wires the service, not a background scheduler).
 *
 * The scheduler owns the DECISION layer only:
 *
 *   trigger classification + eligibility + assurance-aware selection
 *   + deduplication + deterministic identity + admission requests.
 *
 * It does NOT own: validation semantics (WORK-064), browser execution
 * (WORK-065), health determination (WORK-064), evidence (/verification),
 * signal correlation (WORK-067), Work Item creation (WORK-068), progressive
 * release (WORK-069), or any workflow/release/execution authority.
 */
export {
  // §1 vocabularies
  ASSURANCE_PROFILES,
  PROFILE_MODE_POLICY_ALLOWANCE,
  SCHEDULING_ERROR_CODES,
  SCHEDULING_OUTCOMES,
  // the typed error
  ValidationSchedulingError,
} from './types.js';
export {
  // §4b the closed trigger/mode vocabulary + the normative binding (RE-EXPORTED
  // from the WORK-064 authority so consumers depend on ONE surface)
  VALIDATION_MODES,
  VALIDATION_TRIGGERS,
  TRIGGER_MODE_BINDING,
} from '../continuous-validation/types.js';
export {
  // internal — the pure decision functions (exported for direct tests)
  deriveSchedulingIdentity,
  scheduledWindowReference,
} from './internal/scheduling-identity.js';
export {
  evaluateContinuousWindow,
} from './internal/continuous-cadence.js';
export type { ContinuousScheduleWindow } from './internal/continuous-cadence.js';
export {
  classifyTrigger,
} from './internal/trigger-classification.js';
export type { TriggerModeLeg, TriggerClassification } from './internal/trigger-classification.js';
export {
  selectJourneysForTrigger,
  requireAssuranceProfile,
  requireJourneyRegistry,
} from './internal/assurance-selection.js';
export type { JourneySelection } from './internal/assurance-selection.js';
export {
  // the claim-store port's in-memory adapter (the composition default)
  InMemoryScheduledTriggerClaimStore,
} from './internal/in-memory-claim-store.js';
export {
  // the service
  DefaultValidationScheduler,
} from './internal/validation-scheduler.js';
export type {
  // the domain contracts
  AssuranceProfile,
  SchedulingErrorCode,
  SchedulingOutcome,
  ContinuousValidationConfiguration,
  ScheduleValidationTriggerInput,
  SchedulingIdentity,
  SchedulingIdentityInput,
  ScheduledTriggerClaim,
  ScheduledTriggerDecisionRecord,
  ClaimRequest,
  ClaimResult,
  ScheduledTriggerClaimStore,
  JourneySchedulingDecision,
  ModeLegDecision,
  SchedulingDecisionResult,
  ValidationSchedulerDeps,
  ValidationScheduler,
} from './types.js';
export type {
  // re-exports of the consumed authority types (single import surface)
  EffectPolicy,
  Environment,
  TestIdentitySource,
  ValidationJourney,
  ValidationMode,
  ValidationTrigger,
} from './types.js';

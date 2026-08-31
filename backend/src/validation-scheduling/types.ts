/**
 * WORK-066 — Validation Scheduling & Change Triggers: the public domain
 * contracts.
 *
 * The scheduler lives at `src/validation-scheduling/` (application-layer
 * capability OUTSIDE src/modules/ — the WORK-064 continuous-validation /
 * WORK-065 browser-validation precedent; NOT the 18th frozen module) and
 * owns ONLY the scheduling/trigger decision layer:
 *
 *   - trigger classification against the CLOSED trigger vocabulary
 *     (WORK-064's VALIDATION_TRIGGERS — the lifecycle §3 binding);
 *   - deterministic scheduling decisions (injected clock, no randomness,
 *     no hidden process-local state in the decision path);
 *   - trigger deduplication (the claim-store PORT — in-memory adapter in
 *     this Work Order, the documented binding point for the future durable
 *     decision; NO schema migration is authorized by WORK-066);
 *   - PRE_MERGE / POST_RELEASE / CONTINUOUS scheduling semantics;
 *   - CONTINUOUS cadence evaluation (explicit configuration only — no
 *     autonomous unsupervised scheduler, no timers, no loops);
 *   - the fixed assurance-aware journey selection (the lifecycle §2 /
 *     adaptive-assurance §4 matrix — until WORK-058 lands, when selection
 *     delegates to its deterministic function);
 *   - admission requests INTO the WORK-064 authority (the scheduler never
 *     admits, finalizes, or evaluates validation itself).
 *
 * BOUNDARY CONTRACT (spec/work-orders/WORK-066.md — enforced by
 * static-architecture checks):
 *
 *   - NOT a second workflow engine: no Work Item transitions, no PR
 *     creation, no merges (the /workflows + /github authorities own those).
 *   - NOT a second release authority: POST_RELEASE scheduling happens
 *     AFTER a recorded release reference; repository truth: NO release
 *     authority exists yet — the reference is recorded, never invented
 *     (fail closed when absent).
 *   - NOT an autonomous scheduler: CONTINUOUS runs are scheduled only by
 *     explicit configuration; there are no timers/cron/loops here.
 *   - NOT a second verification authority: evidence stays in /verification.
 *   - NOT a second execution authority: browser execution is WORK-065; the
 *     scheduler imports NOTHING from the browser domain.
 *   - NOT the validation authority: WORK-064 admission remains THE gate;
 *     the scheduler selects/requests and delegates admission.
 *   - Determinism: identical (project, journey, environment, revision,
 *     trigger, schedule state, clock) → identical decisions.
 *   - Idempotency: repeated delivery of the same logical event yields ONE
 *     logical scheduled validation (the claim-store boundary).
 *   - Fail-closed: every failure is a typed outcome — never a healthy
 *     validation, never a silent skip.
 */
import type {
  EffectPolicy,
  Environment,
  TestIdentitySource,
  ValidationJourney,
  ValidationMode,
  ValidationTrigger,
} from '../continuous-validation/types.js';

// ============================================================================
// §1  The assurance profiles (lifecycle §1/§2 — the fixed mapping until WORK-058)
// ============================================================================

/** The assurance profiles a trigger may warrant (the v1.0 model, carried into validation scheduling). */
export const ASSURANCE_PROFILES = ['LIGHT', 'STANDARD', 'HIGH_ASSURANCE', 'CRITICAL'] as const;
export type AssuranceProfile = (typeof ASSURANCE_PROFILES)[number];

/**
 * The FIXED profile × mode → effect-policy allowance (lifecycle §2 and
 * adaptive-assurance-evolution §4 — the tables agree). This is the
 * assurance-aware JOURNEY SELECTION the scheduler applies BEFORE the WORK-064
 * admission gate; it is NOT a second safety-policy matrix — selection is a
 * scope filter, never a grant. FORBIDDEN appears in NO allowance: the
 * scheduler never selects a FORBIDDEN journey in any profile or mode.
 */
export const PROFILE_MODE_POLICY_ALLOWANCE: Readonly<
  Record<AssuranceProfile, Readonly<Record<ValidationMode, readonly EffectPolicy[]>>>
> = {
  LIGHT: {
    PRE_MERGE: ['READ_ONLY'],
    POST_RELEASE: [],
    CONTINUOUS: [],
  },
  STANDARD: {
    PRE_MERGE: ['READ_ONLY', 'SAFE_MUTATION'],
    POST_RELEASE: ['READ_ONLY'],
    CONTINUOUS: ['READ_ONLY'],
  },
  HIGH_ASSURANCE: {
    PRE_MERGE: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
    POST_RELEASE: ['READ_ONLY'],
    CONTINUOUS: ['READ_ONLY'],
  },
  CRITICAL: {
    PRE_MERGE: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
    POST_RELEASE: ['READ_ONLY', 'SAFE_MUTATION'],
    CONTINUOUS: ['READ_ONLY', 'SAFE_MUTATION'],
  },
};

// ============================================================================
// §2  The typed scheduling error vocabulary (fail-closed outcomes)
// ============================================================================

export const SCHEDULING_ERROR_CODES = [
  // input vocabulary (fail closed on foreign strings)
  'SCHEDULING_TRIGGER_UNKNOWN',
  'SCHEDULING_ASSURANCE_INVALID',
  // authority bindings (the required per-trigger references)
  'SCHEDULING_PROJECT_REQUIRED',
  'SCHEDULING_REVISION_REQUIRED',
  'SCHEDULING_RELEASE_REFERENCE_REQUIRED',
  'SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED',
  'SCHEDULING_CADENCE_INVALID',
  'SCHEDULING_CONTINUOUS_SCOPE_MISMATCH',
  // environment eligibility (defense-in-depth ahead of WORK-064 admission)
  'SCHEDULING_ENVIRONMENT_REQUIRED',
  'SCHEDULING_ENVIRONMENT_MODE_MISMATCH',
  // journey eligibility (the scheduler admits only DECLARED journeys)
  'SCHEDULING_JOURNEY_REGISTRY_EMPTY',
  'SCHEDULING_JOURNEY_MISSING',
  'SCHEDULING_NO_ELIGIBLE_JOURNEYS',
  // the WORK-064 admission surface (echoed, never re-implemented)
  'SCHEDULING_ADMISSION_REJECTED',
  'SCHEDULING_DEPENDENCY_UNAVAILABLE',
] as const;
export type SchedulingErrorCode = (typeof SCHEDULING_ERROR_CODES)[number];

/** The typed scheduling error (thrown by the pure helpers; surfaced as typed `rejected` outcomes by the service). */
export class ValidationSchedulingError extends Error {
  constructor(
    readonly code: SchedulingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationSchedulingError';
  }
}

// ============================================================================
// §3  The outcome vocabulary
// ============================================================================

/**
 * The scheduling decision outcomes. `duplicate` is the idempotent
 * re-delivery outcome (the logical event was already scheduled); `conflict`
 * is the same-identity/different-content anomaly (fail closed); `rejected`
 * is a typed eligibility/admission failure. Scheduling failures NEVER become
 * healthy validations.
 */
export const SCHEDULING_OUTCOMES = ['scheduled', 'duplicate', 'conflict', 'rejected'] as const;
export type SchedulingOutcome = (typeof SCHEDULING_OUTCOMES)[number];

// ============================================================================
// §4  The trigger event input (consumed from the existing authorities)
// ============================================================================

/**
 * The explicit CONTINUOUS configuration (lifecycle §4: "A CONTINUOUS run is
 * admitted only by explicit configuration — no autonomous unsupervised
 * scheduling"). The configuration IS the authorization for CONTINUOUS
 * scheduling; its scope must match the trigger's project/environment
 * (fail closed otherwise). For `SCHEDULED` triggers the configuration
 * additionally carries the cadence (`intervalMs`) — the window math derives
 * from it deterministically.
 */
export interface ContinuousValidationConfiguration {
  /** The configured project scope (must equal the trigger's project). */
  readonly projectId: string;
  /** The configured production environment scope (must equal the target environment). */
  readonly environmentId: string;
  /**
   * The cadence — a fixed interval in milliseconds. REQUIRED for `SCHEDULED`
   * triggers (the scheduled-interval cadence); optional for the event-driven
   * CONTINUOUS triggers (RUNTIME_SIGNAL / USER_FEEDBACK — the standing
   * authorization).
   */
  readonly intervalMs?: number;
}

/**
 * The typed trigger event presented to the scheduler. The trigger kind MUST
 * be one of WORK-064's closed VALIDATION_TRIGGERS vocabulary — the scheduler
 * consumes triggers from the existing authorities (the /github
 * PR/deployment/release authority, the runtime/audit observation authority,
 * the /architecture ACR authority, the security signal intake) and invents
 * NONE of its own. `MANUAL` is NOT a trigger kind: a manual request binds to
 * one of the nine (e.g. a `SCHEDULED` trigger under explicit configuration).
 */
export interface ScheduleValidationTriggerInput {
  /** The trigger kind (WORK-064's closed vocabulary; foreign values fail closed). */
  readonly trigger: string;
  /** The tenant/project scope of the event (non-empty; the scheduling identity includes it). */
  readonly projectId: string;
  /** The assurance level the trigger warrants (LIGHT/STANDARD/HIGH_ASSURANCE/CRITICAL). */
  readonly assurance: string;
  /**
   * The DECLARED journey registry (WORK-064's authority — the ONLY journeys
   * schedulable; the scheduler admits no journey that is not declared here).
   */
  readonly journeys: readonly ValidationJourney[];
  /**
   * The change's affected journey ids (the affected-surface scope for
   * LIGHT/STANDARD/HIGH_ASSURANCE selection). Absent → the full declared
   * registry is the affected scope (the maximal honest scope).
   */
  readonly affectedJourneyIds?: readonly string[];
  /** Integration-scope journey ids (the HIGH_ASSURANCE selection adds these). */
  readonly integrationJourneyIds?: readonly string[];
  /**
   * The PRE_MERGE target environment (kind preview|isolated). REQUIRED when
   * the trigger binds a PRE_MERGE leg.
   */
  readonly previewEnvironment?: Environment;
  /**
   * The production target environment (kind production). REQUIRED when the
   * trigger binds a POST_RELEASE or CONTINUOUS leg.
   */
  readonly productionEnvironment?: Environment;
  /** The identity source presented to the WORK-064 admission boundary. */
  readonly identitySource: TestIdentitySource;
  /**
   * The change/subject reference: the revision for PRE_MERGE-bound triggers
   * (the PR head SHA, the ACR id, the finding id, the dependency-change id);
   * the signal/feedback reference for the event-driven CONTINUOUS triggers.
   * REQUIRED for those trigger kinds (fail closed when absent).
   */
  readonly revision?: string;
  /**
   * The recorded release reference. REQUIRED for POST_RELEASE legs
   * (repository truth: no release authority exists yet — the reference is
   * recorded, never invented; POST_RELEASE fails closed without it).
   */
  readonly releaseRef?: string;
  /**
   * For the two-mode triggers (SECURITY_FINDING, DEPENDENCY_CHANGE): whether
   * the subject is already in the released production deployment — the
   * POST_RELEASE leg is scheduled ONLY when this is true (and then requires
   * `releaseRef`).
   */
  readonly escalatedToProduction?: boolean;
  /** REQUIRED for CONTINUOUS-bound triggers (the explicit configuration). */
  readonly continuous?: ContinuousValidationConfiguration;
  /** Injectable clock for deterministic tests (defaults to the service's injected clock). */
  readonly now?: () => Date;
}

// ============================================================================
// §5  The scheduling identity (deterministic, no randomness)
// ============================================================================

/** The inputs of the deterministic scheduling identity (the logical event's identity). */
export interface SchedulingIdentityInput {
  readonly trigger: ValidationTrigger;
  readonly projectId: string;
  readonly journeyId: string;
  readonly environmentId: string;
  readonly mode: ValidationMode;
  /**
   * The logical reference of the event for this leg: the revision
   * (PRE_MERGE), the release reference (POST_RELEASE), the scheduled window
   * (`scheduled-window:<index>` — CONTINUOUS/SCHEDULED), or the signal
   * reference (CONTINUOUS/RUNTIME_SIGNAL|USER_FEEDBACK).
   */
  readonly reference: string;
}

/** The derived scheduling identity (pure — sha256 over the canonical fields). */
export interface SchedulingIdentity {
  /** `svs_<24 hex>` — the logical identity of the scheduled validation. */
  readonly schedulingId: string;
  /**
   * The content fingerprint (identity + assurance): a re-delivery with the
   * SAME identity but a DIFFERENT fingerprint is a typed conflict — the same
   * logical event cannot warrant two different classifications.
   */
  readonly contentFingerprint: string;
  /** `svr_<12 hex>` — the deterministic WORK-064 run id for this scheduling unit. */
  readonly runId: string;
}

// ============================================================================
// §6  The claim store port (the dedup boundary)
// ============================================================================

/** The per-(leg × journey) decision record stored with the claim (the resumable linkage). */
export interface ScheduledTriggerDecisionRecord {
  readonly outcome: SchedulingOutcome;
  readonly code: string;
  readonly reason: string;
  readonly trigger: ValidationTrigger;
  readonly projectId: string;
  readonly journeyId: string;
  readonly environmentId: string;
  readonly mode: ValidationMode;
  readonly reference: string;
  readonly runId: string | null;
  readonly admitted: boolean;
}

/** A stored claim (pending until `record` fills the decision). */
export interface ScheduledTriggerClaim {
  readonly schedulingId: string;
  readonly contentFingerprint: string;
  readonly claimedAt: string;
  /** Null while the claiming actor's admission is in flight. */
  readonly decision: ScheduledTriggerDecisionRecord | null;
}

/** The claim request. */
export interface ClaimRequest {
  readonly schedulingId: string;
  readonly contentFingerprint: string;
}

/** The claim result. */
export interface ClaimResult {
  /** `claimed` (you own it), `duplicate` (already claimed — idempotent re-delivery), or `conflict` (same identity, different content). */
  readonly status: 'claimed' | 'duplicate' | 'conflict';
  readonly schedulingId: string;
  /** The prior claim (present for `duplicate`/`conflict`; may carry a null decision while pending). */
  readonly original: ScheduledTriggerClaim | null;
}

/**
 * The trigger-deduplication PORT. The in-memory adapter is the composition
 * default in this Work Order (NO schema migration is authorized — the
 * WORK-064 run-repository precedent; durable scheduling state is a future
 * architect-authorized ACR binding at this exact port). The PostgreSQL
 * contract — keyed uniqueness where the database constraint, not an
 * application race, decides the winner — is proven by the real-PG two-actor
 * integration suite against a test-schema table implementing this port.
 */
export interface ScheduledTriggerClaimStore {
  /**
   * Atomically claim the scheduling identity: the first claim wins;
   * re-delivery with the same identity and fingerprint yields `duplicate`
   * (echoing the original claim); the same identity with a different
   * fingerprint yields `conflict` (fail closed).
   */
  claim(request: ClaimRequest): Promise<ClaimResult>;
  /** Record the decision for a claim the actor owns (idempotent per id). */
  record(schedulingId: string, decision: ScheduledTriggerDecisionRecord): Promise<void>;
  /** Release an incomplete claim (admission dependency failure — the re-drive retries). */
  release(schedulingId: string): Promise<void>;
  /** Read a claim (null when absent — never fabricated). */
  find(schedulingId: string): Promise<ScheduledTriggerClaim | null>;
}

// ============================================================================
// §7  The service contract (the decision layer)
// ============================================================================

/** The per-journey scheduling decision (the full governed linkage). */
export interface JourneySchedulingDecision {
  readonly journeyId: string;
  readonly journeyName: string;
  /** Whether the journey was IN SCOPE for this trigger (the assurance-aware selection). */
  readonly selected: boolean;
  /** Why the journey was selected or excluded (explicit, never silent). */
  readonly selectionReason: string;
  /** Present when the journey was selected (the deterministic identity). */
  readonly schedulingId: string | null;
  readonly contentFingerprint: string | null;
  /** The deterministic WORK-064 run id (present when selected). */
  readonly runId: string | null;
  /**
   * The per-journey outcome: `scheduled` (newly admitted), `duplicate`
   * (already scheduled — the original linkage echoed), `conflict`
   * (same identity, different content), `admission_rejected` (the WORK-064
   * gate rejected), or `not_attempted` (not selected).
   */
  readonly outcome: 'scheduled' | 'duplicate' | 'conflict' | 'admission_rejected' | 'not_attempted';
  /** The WORK-064 admission echo (present when admission was attempted). */
  readonly admission: { admitted: boolean; code: string; reason: string } | null;
  /** For duplicates: the ORIGINAL decision's linkage (the idempotent echo). */
  readonly originalDecision: ScheduledTriggerDecisionRecord | null;
}

/** The per-mode-leg decision. */
export interface ModeLegDecision {
  readonly mode: ValidationMode;
  readonly environmentId: string;
  /** The leg's logical reference (revision / releaseRef / scheduled window / signal ref). */
  readonly reference: string;
  /** Whether any journey was newly scheduled on this leg. */
  readonly scheduled: boolean;
  /** Explicit reason when the leg was skipped (no eligible journeys — never silent). */
  readonly legSkipReason: string | null;
  readonly journeys: readonly JourneySchedulingDecision[];
}

/** The top-level scheduling decision result. */
export interface SchedulingDecisionResult {
  readonly outcome: SchedulingOutcome;
  readonly code: SchedulingErrorCode | 'SCHEDULED' | 'DUPLICATE_SUPPRESSED' | 'SCHEDULING_CONFLICT';
  readonly reason: string;
  readonly trigger: ValidationTrigger;
  readonly projectId: string;
  readonly assurance: AssuranceProfile;
  readonly legs: readonly ModeLegDecision[];
  /** The injected clock's evaluation time (determinism proof). */
  readonly evaluatedAt: string;
}

/** The service dependencies (all injected — no hidden process-local state). */
export interface ValidationSchedulerDeps {
  /** The WORK-064 domain service — THE admission authority (never re-implemented). */
  readonly continuousValidationService: import('../continuous-validation/index.js').ContinuousValidationService;
  /** The trigger-deduplication port (in-memory adapter by default; the durable binding point). */
  readonly claimStore: ScheduledTriggerClaimStore;
  /** Observability only — never authority. */
  readonly logger: import('@platform/logger.js').Logger;
  /** The REQUIRED injected clock (no implicit global time in the decision path). */
  readonly now: () => Date;
}

/** The validation scheduler contract (WORK-066 — the scheduling/trigger decision layer). */
export interface ValidationScheduler {
  /**
   * Decide the scheduling for a typed trigger event: classify → eligibility →
   * mode binding → assurance-aware journey selection → dedup claim → WORK-064
   * admission. Deterministic for identical (project, journey, environment,
   * revision, trigger, schedule state, clock). Fail-closed: every failure is
   * a typed outcome, never a healthy validation.
   */
  scheduleValidationTrigger(input: ScheduleValidationTriggerInput): Promise<SchedulingDecisionResult>;
  /**
   * Read a prior scheduling decision by identity (the resumable linkage —
   * reconciliation reads; null when absent, never fabricated).
   */
  findSchedulingDecision(schedulingId: string): Promise<ScheduledTriggerClaim | null>;
}

// ============================================================================
// §8  Re-exports of the consumed authority types (single import surface)
// ============================================================================

export type {
  EffectPolicy,
  Environment,
  TestIdentitySource,
  ValidationJourney,
  ValidationMode,
  ValidationTrigger,
} from '../continuous-validation/types.js';

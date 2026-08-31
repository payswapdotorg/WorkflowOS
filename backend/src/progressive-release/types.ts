/**
 * WORK-069 — Progressive Release & Runtime Validation (the domain model).
 *
 * The FEEDBACK BINDING LAYER that binds the existing release/deployment
 * authority, the WORK-064 synthetic validation authority, and the existing
 * runtime/audit observation authorities into the governed
 * continue / halt / recover decision. It lives at
 * `src/progressive-release/` (application-layer capability OUTSIDE
 * src/modules/ — the WORK-064 continuous-validation / WORK-065
 * browser-validation / WORK-066 validation-scheduling / WORK-067
 * engineering-signals precedent; NOT the 18th frozen module).
 *
 * AUTHORITIES THIS LAYER CONSUMES (never duplicates):
 *
 *   - validation: the WORK-064 `ContinuousValidationService` (completed
 *     POST_RELEASE runs — the admission/finalization/evidence authority);
 *   - signals: the WORK-067 `EngineeringSignalService` (the halt/recover
 *     consequence channel — a halt's failure evidence becomes an
 *     Engineering Signal that WORK-068 will convert into a governed Work
 *     Item when it lands; WORK-069 NEVER creates a Work Item itself);
 *   - scheduling: the WORK-066 `ValidationScheduler` (UPSTREAM — its
 *     POST_RELEASE RELEASE-trigger leg admits the validation runs this
 *     layer binds, keyed by the SAME recorded releaseRef; this layer owns
 *     NO timers, cadence, claim stores, or trigger classification);
 *   - runtime observation: the existing /runtime deployment authority
 *     (WORK-019/WORK-026 — the provider-recorded deployment status,
 *     consumed through the read-only `RuntimeObservationReader` port
 *     bound in the composition root; NEVER re-implemented here);
 *   - audit: the existing /audit authority (WORK-020 — the decision is
 *     emitted through the `AuditEventWriter` application boundary, the
 *     documented cross-module seam);
 *   - rollback: the EXISTING rollback/recovery authority, consumed
 *     through the `RollbackAuthority` port (repository truth: NO rollback
 *     authority exists yet — the port is the explicit future binding
 *     point and production composes UNBOUND, failing closed with a typed
 *     outcome; NO second rollback engine is created here);
 *   - release mechanics: the existing `/workflows` + `/github` + `/runtime`
 *     surfaces (repository truth: the release authority is DISTRIBUTED —
 *     no ReleaseService exists; this layer records the caller-supplied
 *     releaseRef exactly like WORK-064's POST_RELEASE admission does and
 *     never invents a release identity).
 *
 * PERSISTENCE RULING: the Work Order's parallel-execution metadata
 * declares `migrations: []` — NO schema migration is authorized. The
 * `ProgressiveReleaseDecisionRepository` PORT carries the in-memory
 * adapter (the WORK-064 run-repository / WORK-066 claim-store / WORK-067
 * signal-repository precedent); the durable binding point is a future
 * ACR at the same port, and the PostgreSQL keyed-uniqueness contract is
 * proven by the real-PG two-actor integration suite.
 */

// ============================================================================
// §1  The vocabularies (closed; foreign values fail closed)
// ============================================================================

/**
 * The three progressive rollout stages (the Work Order's canary / partial
 * rollout / full rollout). The stage is DECLARED per decision request by
 * the caller (the existing release surface advancing the rollout) — this
 * layer records and validates it; it never advances a rollout itself
 * (that is the release authority's mechanics).
 */
export const PROGRESSIVE_ROLLOUT_STAGES = ['canary', 'partial', 'full'] as const;
export type ProgressiveRolloutStage = (typeof PROGRESSIVE_ROLLOUT_STAGES)[number];

/** The monotone stage order (canary < partial < full). */
export const PROGRESSIVE_STAGE_ORDER: Readonly<Record<ProgressiveRolloutStage, number>> = {
  canary: 0,
  partial: 1,
  full: 2,
};

/**
 * The three governed decision consequences (the Work Order's loop). The
 * decision layer derives ONLY these; every unsafe/unknown input state maps
 * to a typed `halt` (fail closed — a missing required condition never
 * silently becomes `continue`).
 */
export const PROGRESSIVE_DECISIONS = ['continue', 'halt', 'recover'] as const;
export type ProgressiveDecision = (typeof PROGRESSIVE_DECISIONS)[number];

/**
 * The closed reason vocabulary — every cell of the deterministic policy
 * matrix is typed and explainable. Grouped:
 *
 *   CONTINUE — the only continue reason (healthy validation + ready
 *   runtime observation + every binding matched);
 *
 *   HALT (fail-closed evidence gating) — the §14 safety cases: missing /
 *   unusable validation evidence, missing / ambiguous runtime observation,
 *   and inconsistent rollout state (already halted, already recovered,
 *   stage regression);
 *
 *   HALT (failure semantics) — a completed-but-failed validation or an
 *   unhealthy runtime observation at the partial/full stages (the rollout
 *   stops; the signal feeds the governed chain);
 *
 *   RECOVER — the rollback cases: a FORBIDDEN effect-policy violation in
 *   production (any stage), or a validation/runtime failure while the
 *   exposure is still contained at the canary stage (the canary exists to
 *   catch exactly this; rolling it back is the cheap, safe recovery).
 */
export const PROGRESSIVE_DECISION_REASONS = [
  // continue
  'CONTINUE_VALIDATION_HEALTHY_RUNTIME_READY',
  // halt — fail-closed evidence gating (§14)
  'HALT_VALIDATION_RUN_NOT_FOUND',
  'HALT_VALIDATION_RUN_NOT_COMPLETED',
  'HALT_VALIDATION_MODE_NOT_POST_RELEASE',
  'HALT_VALIDATION_TRIGGER_NOT_RELEASE',
  'HALT_VALIDATION_RELEASE_REF_MISMATCH',
  'HALT_VALIDATION_TENANT_MISMATCH',
  'HALT_VALIDATION_ENVIRONMENT_MISMATCH',
  'HALT_RUNTIME_OBSERVATION_UNAVAILABLE',
  'HALT_RUNTIME_OBSERVATION_NOT_READY',
  'HALT_ROLLOUT_PREVIOUSLY_HALTED',
  'HALT_ROLLOUT_PREVIOUSLY_RECOVERED',
  'HALT_INVALID_STAGE_TRANSITION',
  // halt — failure semantics
  'HALT_VALIDATION_FAILURE',
  'HALT_VALIDATION_ENVIRONMENT_ERROR',
  'HALT_RUNTIME_UNHEALTHY',
  // recover
  'RECOVER_EFFECT_POLICY_VIOLATION',
  'RECOVER_CANARY_VALIDATION_FAILURE',
  'RECOVER_CANARY_RUNTIME_UNHEALTHY',
] as const;
export type ProgressiveDecisionReason = (typeof PROGRESSIVE_DECISION_REASONS)[number];

/**
 * The provider-recorded deployment status vocabulary observed through the
 * /runtime authority's public contract (WORK-019 `DeploymentStatus` —
 * mirrored here as the domain's OWN literal union so the domain imports no
 * module internals; the composition-root adapter maps it totally).
 */
export const PROGRESSIVE_DEPLOYMENT_STATUSES = [
  'queued',
  'building',
  'ready',
  'error',
  'canceled',
] as const;
export type ProgressiveDeploymentStatus = (typeof PROGRESSIVE_DEPLOYMENT_STATUSES)[number];

/** The decision-delivery outcome: a fresh decision or an idempotent duplicate. */
export const PROGRESSIVE_DELIVERY_OUTCOMES = ['decided', 'duplicate'] as const;
export type ProgressiveDeliveryOutcome = (typeof PROGRESSIVE_DELIVERY_OUTCOMES)[number];

// ============================================================================
// §2  The typed error surface (fail closed)
// ============================================================================

export const PROGRESSIVE_RELEASE_ERROR_CODES = [
  // §2 input validation
  'PR_INPUT_TENANT_REQUIRED',
  'PR_INPUT_PROJECT_REQUIRED',
  'PR_INPUT_ENVIRONMENT_REQUIRED',
  'PR_INPUT_RELEASE_REF_REQUIRED',
  'PR_INPUT_STAGE_INVALID',
  'PR_INPUT_VALIDATION_RUN_ID_REQUIRED',
  'PR_INPUT_RELEASE_OBSERVED_AT_INVALID',
  // §3 identity discipline
  'PR_DECISION_IDENTITY_CONFLICT',
  // §4 dependency discipline
  'PR_VALIDATION_AUTHORITY_UNBOUND',
  'PR_SIGNAL_AUTHORITY_UNBOUND',
  'PR_ROLLBACK_INVOCATION_FAILED',
] as const;
export type ProgressiveReleaseErrorCode = (typeof PROGRESSIVE_RELEASE_ERROR_CODES)[number];

/** The typed domain error (mirrors the WORK-064/066/067 surface). */
export class ProgressiveReleaseError extends Error {
  constructor(
    public readonly code: ProgressiveReleaseErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ProgressiveReleaseError';
  }
}

// ============================================================================
// §3  The decision request (the caller-declared binding)
// ============================================================================

/**
 * The governed decision request. The caller is the existing release
 * surface (or the governed operator) advancing a recorded rollout: it
 * supplies the RECORDED release identity, the rollout stage being judged,
 * and the WORK-064 POST_RELEASE validation run that covers the stage.
 * This layer NEVER invents any of these — every field is caller-recorded
 * and validated against the authorities' own records.
 */
export interface DecideProgressiveReleaseInput {
  /** The tenant scope (REQUIRED — participates in the decision identity). */
  readonly tenantId: string;
  /** The project scope (REQUIRED — participates in the decision identity). */
  readonly projectId: string;
  /**
   * The rollout's target environment identity (REQUIRED — the production
   * environment the progressive rollout exposes; matched against the
   * validation run's own environment binding, fail closed on mismatch).
   */
  readonly environmentId: string;
  /**
   * The RECORDED release reference (REQUIRED — the SAME recorded identity
   * WORK-064's POST_RELEASE admission required and WORK-066's POST_RELEASE
   * scheduling leg bound; never invented here, never inferred from a
   * deployment timestamp, commit, URL, or branch).
   */
  readonly releaseRef: string;
  /** The rollout stage being judged (the closed vocabulary; foreign values fail closed). */
  readonly rolloutStage: string;
  /**
   * The WORK-064 validation run id binding this decision (REQUIRED — the
   * run is loaded through the authority's public findRun boundary; a
   * missing/unusable run is a typed fail-closed halt, never a continue).
   */
  readonly validationRunId: string;
  /**
   * OPTIONAL: the caller-recorded release boundary time (ISO-8601). When
   * present and a signal is produced, the signal is release-correlated
   * through the WORK-067 authority (recordedVia 'caller-declared'). When
   * absent, the correlation is skipped (WORK-067's fail-closed
   * unavailable assessment — never an inferred release boundary).
   */
  readonly releaseObservedAt?: string;
  /** Injectable clock for deterministic tests (defaults to the service clock). */
  readonly now?: () => Date;
}

// ============================================================================
// §4  The runtime observation port (the /runtime authority consumed)
// ============================================================================

/**
 * ONE runtime observation consumed from the existing /runtime deployment
 * authority — the provider-RECORDED deployment state (WORK-019/026). The
 * observedAt is the authority record's own recorded time — never the
 * decision clock, never an inference.
 */
export interface RolloutRuntimeObservation {
  readonly kind: 'deployment';
  readonly deploymentId: string;
  readonly deploymentStatus: ProgressiveDeploymentStatus;
  /** The authority record's recorded observation time (ISO-8601). */
  readonly observedAt: string;
}

/**
 * The read-only runtime observation port. The composition root binds the
 * adapter over the /runtime module's public `DeploymentRepository`
 * contract. UNBOUND (or a null read) = the runtime observation is
 * UNAVAILABLE — a typed fail-closed halt, never a continue.
 */
export interface RuntimeObservationReader {
  /** Read the latest provider-recorded deployment observation for the project (null when none exists). */
  readLatestDeploymentObservation(projectId: string): Promise<RolloutRuntimeObservation | null>;
}

// ============================================================================
// §5  The rollback authority port (the EXISTING authority consumed)
// ============================================================================

/** The governed rollback invocation request (provenance-bound). */
export interface RollbackInvocationInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseRef: string;
  readonly rolloutStage: ProgressiveRolloutStage;
  readonly decisionId: string;
  readonly reason: ProgressiveDecisionReason;
}

/**
 * The rollback invocation result. `invoked: false` carries the typed
 * reason — the repository truth today is `ROLLBACK_AUTHORITY_UNBOUND`
 * (no rollback authority exists yet): the RECOVER decision is still
 * derived and recorded (the policy is the policy) with the rollback
 * explicitly NOT invoked and the engineering signal produced, so the
 * governed chain sees the un-executed recovery — it is NEVER silently
 * converted into a continue.
 */
export type RollbackInvocationResult =
  | { readonly invoked: true; readonly rollbackRef: string; readonly note: string | null }
  | { readonly invoked: false; readonly reason: 'ROLLBACK_AUTHORITY_UNBOUND' };

/**
 * The consumption boundary of the EXISTING rollback/recovery authority.
 * Repository truth: no rollback authority exists in the repository today
 * (the release authority is distributed across /workflows + /github +
 * /runtime and implements NO rollback trigger — the dogfooding evidence
 * documents the record/observe model). This port is the explicit binding
 * point for that authority when it lands (or is exposed); production
 * composes it UNBOUND and a RECOVER decision records the typed unbound
 * outcome. NO rollback mechanics are implemented here.
 */
export interface RollbackAuthority {
  invokeRollback(input: RollbackInvocationInput): Promise<RollbackInvocationResult>;
}

// ============================================================================
// §6  The halt/recover signal outcome (the WORK-067 authority consumed)
// ============================================================================

/** One Engineering Signal consequence of a non-continue decision (provenance preserved). */
export interface HaltSignalOutcome {
  readonly signalId: string;
  readonly occurrenceId: string;
  readonly outcome: 'signal-created' | 'occurrence-appended' | 'duplicate-suppressed';
  readonly logicalFailureKey: string;
}

// ============================================================================
// §7  The decision record (immutable; full provenance)
// ============================================================================

/**
 * The governed decision record. Structurally answers the Work Order's
 * provenance questions: which release (releaseRef), which environment
 * (environmentId via the request identity), which rollout stage, which
 * validation run, which runtime observation, which policy
 * (policyVersion), which decision, and why (reason + explanation).
 */
export interface ProgressiveReleaseDecisionRecord {
  /** `prd_<24 hex>` — the deterministic decision identity. */
  readonly decisionId: string;
  /** The full sha256 identity fingerprint (the dedup dimension). */
  readonly identityFingerprint: string;
  /** The content fingerprint (identity + derived decision + reason + policy). */
  readonly contentFingerprint: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly releaseRef: string;
  readonly rolloutStage: ProgressiveRolloutStage;
  readonly validationRunId: string;
  /** The runtime observation the decision consumed (null when unavailable). */
  readonly runtimeObservation: {
    readonly kind: 'deployment';
    readonly deploymentId: string;
    readonly deploymentStatus: ProgressiveDeploymentStatus;
  } | null;
  readonly decision: ProgressiveDecision;
  readonly reason: ProgressiveDecisionReason;
  /** The deterministic human-readable explanation (governed + explainable). */
  readonly explanation: string;
  /** The WORK-067 signal consequences (empty for continue and meta-halts). */
  readonly signalOutcomes: readonly HaltSignalOutcome[];
  /** Present on recover decisions (invoked or the typed unbound reason). */
  readonly rollback: RollbackInvocationResult | null;
  /** The WORK-064 outcome kind consumed as the decisive evidence (null when the run was unusable). */
  readonly validationOutcomeKind: string | null;
  /** The deterministic policy version (the decision is reproducible). */
  readonly policyVersion: string;
  /** The injected clock's decision time (ISO-8601; deterministic under injection). */
  readonly decidedAt: string;
}

/** The decide() result: a fresh decision, or an idempotent duplicate re-delivery. */
export interface ProgressiveReleaseDecisionResult {
  readonly outcome: ProgressiveDeliveryOutcome;
  readonly decision: ProgressiveReleaseDecisionRecord;
}

// ============================================================================
// §8  The persistence port (in-memory adapter; NO migration authorized)
// ============================================================================

/**
 * The decision persistence port. ARCHITECTURAL RULING: the Work Order
 * declares `migrations: []` — the domain stays at this PORT with the
 * in-memory adapter (the WORK-064/066/067 precedent). The keyed
 * uniqueness contract (`decision_id` PRIMARY KEY + the identity
 * fingerprint UNIQUE — the DATABASE constraint, not an application race,
 * decides the winner) is proven under real PostgreSQL by the two-actor
 * integration suite; the durable binding point is a future ACR at this
 * port.
 */
export interface ProgressiveReleaseDecisionRepository {
  /** Persist a decision (insert-or-converge; a same-id/different-fingerprint save is a typed conflict). */
  save(record: ProgressiveReleaseDecisionRecord): Promise<ProgressiveReleaseDecisionRecord>;
  /** Read a decision by id (null when absent — never fabricated). */
  findById(decisionId: string): Promise<ProgressiveReleaseDecisionRecord | null>;
  /** List the decision history of one rollout (oldest first — the recorded rollout state). */
  listForRollout(tenantId: string, projectId: string, releaseRef: string): Promise<readonly ProgressiveReleaseDecisionRecord[]>;
}

// ============================================================================
// §9  The service contract (composed through buildApp for future consumers)
// ============================================================================

/** The service dependencies (all injected — no hidden process-local state). */
export interface ProgressiveReleaseServiceDeps {
  /** The WORK-064 authority — completed POST_RELEASE runs (REQUIRED). */
  readonly continuousValidationService: import('../continuous-validation/index.js').ContinuousValidationService;
  /** The WORK-067 authority — the halt/recover signal channel (REQUIRED). */
  readonly engineeringSignalService: import('../engineering-signals/index.js').EngineeringSignalService;
  /**
   * The /runtime observation reader port (the composition-root adapter
   * over the module's public DeploymentRepository). UNBOUND = the runtime
   * observation is unavailable → typed fail-closed halt.
   */
  readonly runtimeObservationReader?: RuntimeObservationReader;
  /**
   * The EXISTING rollback authority port. UNBOUND in production today
   * (repository truth: no rollback authority exists — the documented
   * future binding point; a RECOVER decision records the typed unbound
   * outcome, never a silent continue).
   */
  readonly rollbackAuthority?: RollbackAuthority;
  /** The decision persistence port (the in-memory adapter is the composition default). */
  readonly decisionRepository: ProgressiveReleaseDecisionRepository;
  /** OPTIONAL: the /audit application boundary (WORK-020 — the decision's forensic trail). */
  readonly auditWriter?: import('@modules/audit/index.js').AuditEventWriter;
  /** Observability only — never authority. */
  readonly logger?: import('@platform/logger.js').Logger;
  /** The REQUIRED injected clock (no implicit global time in the decision path). */
  readonly now: () => Date;
}

/** The progressive-release decision layer's public contract. */
export interface ProgressiveReleaseService {
  /**
   * Derive the governed continue/halt/recover decision for one rollout
   * stage binding, execute its governed consequences (the WORK-067 signal
   * flow, the rollback authority invocation, the /audit event), and
   * persist the decision record. Deterministic for identical (tenant,
   * project, release, stage, validation run, runtime observation, rollout
   * history, clock). Idempotent under duplicate delivery (same identity →
   * the recorded decision is returned; no duplicate halt action). Fail
   * closed: every unsafe/unknown state is a typed halt, never a continue.
   */
  decideProgressiveRelease(input: DecideProgressiveReleaseInput): Promise<ProgressiveReleaseDecisionResult>;
  /** Read a decision by id (null when absent — never fabricated). */
  findDecision(decisionId: string): Promise<ProgressiveReleaseDecisionRecord | null>;
  /** List a rollout's decision history (read-only — the recorded rollout state). */
  listDecisionsForRollout(tenantId: string, projectId: string, releaseRef: string): Promise<readonly ProgressiveReleaseDecisionRecord[]>;
}

// ============================================================================
// §10  The derivation facts (the pure policy inputs)
// ============================================================================

/** The validation-evidence status consumed from the WORK-064 authority. */
export type ValidationEvidenceStatus =
  | { readonly usable: true; readonly run: import('../continuous-validation/index.js').ValidationRun }
  | { readonly usable: false; readonly reason: Extract<ProgressiveDecisionReason, `HALT_VALIDATION_${string}`> };

/** The runtime-observation status consumed through the /runtime port. */
export type RuntimeObservationStatus =
  | { readonly state: 'unavailable' }
  | { readonly state: 'not-ready'; readonly observation: RolloutRuntimeObservation }
  | { readonly state: 'healthy'; readonly observation: RolloutRuntimeObservation }
  | { readonly state: 'unhealthy'; readonly observation: RolloutRuntimeObservation };

/** The recorded rollout state derived from the decision history (never a second release engine). */
export interface PriorRolloutState {
  /** A prior decision for this rollout concluded halt (the rollout is stopped). */
  readonly previouslyHalted: boolean;
  /** A prior decision for this rollout concluded recover (the rollout was rolled back). */
  readonly previouslyRecovered: boolean;
  /** The highest stage any prior decision judged (null when no history). */
  readonly highestDecidedStage: ProgressiveRolloutStage | null;
}

/** The pure derivation result. */
export interface DerivationResult {
  readonly decision: ProgressiveDecision;
  readonly reason: ProgressiveDecisionReason;
  readonly explanation: string;
}

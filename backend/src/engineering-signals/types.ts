/**
 * WORK-067 — Engineering Signal & Regression Correlation: the public
 * domain contracts.
 *
 * The domain lives at `src/engineering-signals/` (application-layer
 * capability OUTSIDE src/modules/, mirroring the WORK-064
 * continuous-validation / WORK-065 browser-validation / WORK-066
 * validation-scheduling precedent — NOT an 18th frozen module) and owns
 * ONLY the correlation layer:
 *
 *   - normalization of raw observations into provenance-preserving
 *     Engineering Signals (the TEMPORARY compatibility seam — see the
 *     WORK-056 boundary note below);
 *   - deduplication (the same logical failure converges on ONE signal
 *     identity — deterministic, tenant/project/environment-scoped);
 *   - release correlation (each signal is correlated to the release(s)
 *     its observations overlap in time and causation with — the release
 *     identity is RECORDED through caller-supplied contexts, never
 *     invented from timestamps/commits/URLs/branches);
 *   - regression identification (absent-before + present-after, or
 *     severity-increased-after, per correlated release — ADVISORY);
 *   - provenance preservation (sources, raw observation references,
 *     correlation reasoning — reconstructable, never reduced to a hash).
 *
 * BOUNDARY CONTRACT (spec/work-orders/WORK-067.md — enforced by
 * static-architecture checks):
 *
 *   - NOT a second verification authority: the formal verdict stays in
 *     `/verification` (WORK-015). A signal is ADVISORY; it maps to no
 *     evidence row, creates no verification run, and flips no verdict.
 *   - NOT a second workflow authority: signals NEVER transition Work
 *     Items, approve/merge PRs, or mutate workflow/architecture state.
 *     They feed planning through `/work-items` via the FUTURE governed
 *     WORK-068 converter (not implemented here).
 *   - NOT a second signal INTAKE authority: WORK-056 (Engineering
 *     Signals and Feedback Intake — planned) owns the signal TAXONOMY and
 *     INTAKE. Until WORK-056 lands, the normalization boundary in this
 *     domain is an EXPLICITLY TEMPORARY compatibility seam (documented at
 *     {@link RawObservationInput}); when WORK-056 lands, intake is
 *     DELEGATED to it and this domain focuses on correlation.
 *   - NOT a code-mutation authority: no signal causes a code change.
 *   - NOT a silent healthy-state converter: a failure observation
 *     ALWAYS becomes a recorded signal occurrence; processing a failure
 *     can never make it disappear or become healthy (the WORK-064
 *     invariant, carried forward).
 *   - NOT a scheduler / executor: no validation scheduling (WORK-066),
 *     no browser execution (WORK-065), no cadence logic, no timers, no
 *     queues. This domain CONSUMES upstream outputs only.
 *   - Determinism: identical (observation inputs, identity scope,
 *     release contexts, clock) → byte-identical signals and assessments.
 *     The clock is injected; observation times are RECORDED values, not
 *     wall-clock reads; identities are sha256 derivations, never random.
 *   - Idempotency: repeated delivery of the same observation converges
 *     on the same occurrence (the keyed uniqueness boundary).
 *   - Fail-closed: unknown sources/severities, missing scope, missing
 *     release contexts, scope mismatches — all typed rejections or
 *     explicit `unavailable` states, never silent success.
 */
import type { ValidationRun } from '../continuous-validation/types.js';

// ============================================================================
// §1  The closed vocabularies
// ============================================================================

/**
 * The heterogeneous observation sources (the Work Order's list). Which of
 * these have OPERATIONAL adapters today is recorded honestly at the
 * consumption boundary: synthetic validation (WORK-064) is consumed
 * through the authority's public service; CI (/github evidence rows),
 * runtime, telemetry, security, user-feedback, and deployment
 * observations are preserved as raw observation references + payloads
 * (opaque, provenance-preserving — this domain never dereferences them).
 * WORK-056's future taxonomy owns the intake classification.
 */
export const SIGNAL_SOURCES = [
  'validation', // synthetic validation failures (WORK-064)
  'ci', // CI failures (/github CiRunEvidence rows)
  'runtime', // runtime failures (existing runtime authorities)
  'telemetry', // telemetry anomalies (existing runtime telemetry)
  'security', // security signals (existing security authorities)
  'user-feedback', // user feedback (the existing intake surfaces)
  'deployment', // deployment/release observations (/runtime)
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/**
 * The signal severity vocabulary — the repository's EXISTING four-level
 * vocabulary (the maintenance authority's `AdvisoryRecord.severity` /
 * `MaintenanceSignalMetadata.severity`, WORK-041). Not invented here; the
 * total order below is the ONLY ordering used for severity-escalation
 * semantics.
 */
export const SIGNAL_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

/**
 * The total severity order (regression escalation): low < medium < high <
 * critical. A severity INCREASE across a release boundary is
 * regression-relevant; a DECREASE is never promoted.
 */
export const SEVERITY_ORDER: Readonly<Record<SignalSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ============================================================================
// §2  The typed error vocabulary (fail-closed rejections)
// ============================================================================

export const ENGINEERING_SIGNAL_ERROR_CODES = [
  // observation input vocabulary (fail closed on foreign values)
  'SIGNAL_SOURCE_UNKNOWN',
  'SIGNAL_SEVERITY_UNKNOWN',
  // observation scope (the dedup dimensions are REQUIRED)
  'SIGNAL_TENANT_REQUIRED',
  'SIGNAL_PROJECT_REQUIRED',
  'SIGNAL_ENVIRONMENT_REQUIRED',
  'SIGNAL_LOGICAL_KEY_REQUIRED',
  // observation content/provenance
  'SIGNAL_OBSERVED_AT_INVALID',
  'SIGNAL_OBSERVATION_REF_INVALID',
  'SIGNAL_RAW_PAYLOAD_REQUIRED',
  // identity / persistence boundary
  'SIGNAL_IDENTITY_CONFLICT',
  // release correlation context
  'SIGNAL_RELEASE_CONTEXT_INVALID',
  'SIGNAL_RELEASE_REF_REQUIRED',
  'SIGNAL_RELEASED_AT_INVALID',
  'SIGNAL_RELEASE_PROJECT_MISMATCH',
  // the WORK-064 consumption boundary
  'SIGNAL_VALIDATION_RUN_NOT_FOUND',
  'SIGNAL_VALIDATION_RUN_NOT_COMPLETED',
  'SIGNAL_SCOPE_MISMATCH',
  'SIGNAL_DEPENDENCY_UNAVAILABLE',
  // reads
  'SIGNAL_NOT_FOUND',
] as const;
export type EngineeringSignalErrorCode = (typeof ENGINEERING_SIGNAL_ERROR_CODES)[number];

/** The typed domain error (discriminated by `code`). */
export class EngineeringSignalError extends Error {
  constructor(
    readonly code: EngineeringSignalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EngineeringSignalError';
  }
}

// ============================================================================
// §3  The raw observation input (the TEMPORARY normalization seam)
// ============================================================================

/**
 * A typed pointer to the raw observation a signal occurrence was derived
 * from. The ref is an OPAQUE authority locator (e.g. a validation run id +
 * failure identity, a `wfos_github_ci_evidence` row id, a deployment row
 * id). This domain NEVER dereferences it — it records it so the causal
 * chain stays reconstructable. A hash alone would NOT be enough (the raw
 * payload is preserved separately on the occurrence).
 */
export interface SignalObservationReference {
  /** The source authority's reference kind (e.g. 'validation-run', 'ci-evidence'). */
  readonly kind: string;
  /** The authority's opaque locator (non-empty). */
  readonly ref: string;
  /** Optional traceability detail (e.g. the failing step/expectation). */
  readonly detail?: string;
}

/**
 * The raw observation input — the TEMPORARY compatibility seam.
 *
 * ARCHITECTURAL BOUNDARY (spec/work-orders/WORK-067.md "Relationship to
 * WORK-056"): WORK-056 (planned) owns the signal TAXONOMY and INTAKE.
 * Until WORK-056 lands, this input is the documented normalization seam
 * through which raw observations enter the correlation layer — it is NOT
 * a permanent intake authority, and when WORK-056 lands, intake is
 * DELEGATED to it (this seam retires into a consumed taxonomy). The seam
 * keeps the same provenance discipline WORK-056 will require: scope,
 * classification, severity, observation time, the raw observation
 * reference, and the raw payload — all explicit, all preserved.
 */
export interface RawObservationInput {
  /** The observation source (the closed vocabulary; foreign values fail closed). */
  readonly source: SignalSource;
  /** The tenant scope (REQUIRED — participates in the dedup identity). */
  readonly tenantId: string;
  /** The project scope (REQUIRED — participates in the dedup identity). */
  readonly projectId: string;
  /** The environment scope (REQUIRED — participates in the dedup identity;
   *  the same failure in preview and production is TWO signals). */
  readonly environmentId: string;
  /**
   * The canonical logical-failure classification — THE dedup dimension.
   * The same logical failure observed multiple times (across runs, across
   * sources) converges on one signal identity when (and only when) this
   * classification matches. The TEMPORARY seam discipline: the caller
   * supplies the classification (the WORK-064 adapter derives it
   * deterministically; other sources supply their own); WORK-056's
   * taxonomy will own it when it lands.
   */
  readonly logicalFailureKey: string;
  /** The observation's severity (the repository's closed vocabulary). */
  readonly severity: SignalSeverity;
  /**
   * The observation time — an ISO-8601 timestamp RECORDED by the source
   * (the run/step/CI/deployment observation time). Never the processing
   * clock: the injected clock governs only `recordedAt` bookkeeping.
   */
  readonly observedAt: string;
  /** The raw observation reference — PRESERVED (never reduced to a hash). */
  readonly observationRef: SignalObservationReference;
  /**
   * The raw payload snapshot — PRESERVED verbatim (the full failure
   * record, the CI conclusion payload, …). Must be present (null/undefined
   * rejected): a signal without its raw observation content is a
   * free-floating signal.
   */
  readonly raw: unknown;
  /**
   * The causal release binding RECORDED by the source authority (WORK-064
   * POST_RELEASE runs carry `releaseRef`; sources without a recorded
   * binding supply null). This is the ONLY release-identity input derived
   * from observations — WORK-067 never invents one.
   */
  readonly releaseRef?: string | null;
  /** Injectable clock for deterministic tests (defaults to the service clock). */
  readonly now?: () => Date;
}

// ============================================================================
// §4  The deterministic signal identity (no randomness)
// ============================================================================

/** The identity inputs (the logical failure's scope dimensions). */
export interface SignalIdentityInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly logicalFailureKey: string;
}

/** The derived deterministic identity (pure — sha256 over canonical fields). */
export interface SignalIdentity {
  /** `sig_<24 hex>` — the logical identity of the Engineering Signal. */
  readonly signalId: string;
  /**
   * The identity content fingerprint (sha256 over ALL identity fields).
   * The repository's keyed uniqueness boundary: two saves with the same
   * fingerprint converge; the same signalId with a different fingerprint
   * is a typed identity conflict.
   */
  readonly identityFingerprint: string;
}

/**
 * The per-occurrence identity: deterministic over (signal identity, the
 * raw observation reference, the observation time). Re-delivery of the
 * SAME observation (same ref + same observedAt) yields the SAME occurrence
 * id — the idempotent convergence key. A DIFFERENT time or a different
 * source observation of the same logical failure yields a distinct
 * occurrence (appended to the same signal).
 */
export interface SignalOccurrenceIdentity {
  /** `occ_<24 hex>` — the deterministic occurrence identity. */
  readonly occurrenceId: string;
}

// ============================================================================
// §5  The Engineering Signal record (append-only occurrences)
// ============================================================================

/**
 * ONE observation of the logical failure, preserved with its full
 * provenance: the source, the recorded time, the severity at observation
 * time, the raw observation reference + payload, the causal release
 * binding, and the convergence reasoning (why this occurrence belongs to
 * this signal). Append-only: the signal never rewrites or drops an
 * occurrence.
 */
export interface SignalOccurrence {
  readonly occurrenceId: string;
  readonly source: SignalSource;
  readonly observedAt: string;
  readonly severity: SignalSeverity;
  /** The raw observation reference — PRESERVED. */
  readonly observationRef: SignalObservationReference;
  /** The raw payload snapshot — PRESERVED verbatim (never a hash alone). */
  readonly raw: unknown;
  /** The causal release binding recorded by the source (null when none). */
  readonly releaseRef: string | null;
  /** When the signal system recorded this occurrence (the injected clock). */
  readonly recordedAt: string;
  /** Why this occurrence converged on this signal (the correlation reasoning). */
  readonly convergenceReason: string;
}

/**
 * One release correlation decision, per release context. The entry records
 * the release identity AS SUPPLIED (the recorded reference + boundary
 * time), the correlated/not-correlated decision, and the causal basis:
 *
 *   - `provenance-release-ref` — the signal's occurrences record the SAME
 *     release reference (the direct causal chain — VERIFIED against the
 *     occurrence provenance);
 *   - `caller-declared` — the signal has NO recorded causal binding and
 *     the caller declared the association (recorded verbatim — the weaker
 *     basis, explicit to downstream governance);
 *   - `causal-binding-mismatch` — the signal's occurrences record a
 *     DIFFERENT release reference: the correlation is REJECTED (the
 *     wrong-release discrimination — a signal causally bound to release A
 *     is never blindly correlated to release B);
 *   - `no-time-overlap` — the signal's observations do not overlap the
 *     release's post-release window (correlation rejected).
 */
export interface ReleaseCorrelationEntry {
  readonly releaseRef: string;
  readonly releasedAt: string;
  readonly projectId: string;
  readonly correlated: boolean;
  readonly causalBasis:
    | 'provenance-release-ref'
    | 'caller-declared'
    | 'causal-binding-mismatch'
    | 'no-time-overlap'
    | 'not-correlated';
  /** The explicit correlation decision reason (never silent). */
  readonly reason: string;
}

/**
 * The per-release regression assessment (ADVISORY). The occurrence split
 * at the release boundary: `before` = observedAt < releasedAt;
 * `after` = observedAt >= releasedAt (the release is live from its
 * boundary — deterministic, documented).
 */
export interface ReleaseRegressionAssessment {
  readonly releaseRef: string;
  readonly releasedAt: string;
  /**
   * `likely_regression` — absent-before + present-after, or
   * severity-increased-after (per the Work Order's regression contract);
   * `not_a_regression` — present before AND after (a release happening is
   * not itself a regression), severity DECREASED, or resolved-after;
   * `not_assessable` — the correlation did not support an assessment.
   */
  readonly outcome: 'likely_regression' | 'not_a_regression' | 'not_assessable';
  /** The explicit assessment reasoning (reconstructable, never silent). */
  readonly reason: string;
  /** The occurrence ids observed strictly before the release boundary. */
  readonly beforeOccurrenceIds: readonly string[];
  /** The occurrence ids observed at/after the release boundary. */
  readonly afterOccurrenceIds: readonly string[];
  /**
   * The severity immediately before the boundary (the LAST pre-release
   * occurrence's severity; null when absent-before). Deterministic
   * ordering: (observedAt, recordedAt, occurrenceId).
   */
  readonly severityBefore: SignalSeverity | null;
  /**
   * The severity immediately after the boundary (the FIRST post-release
   * occurrence's severity; null when absent-after). Deterministic
   * ordering: (observedAt, recordedAt, occurrenceId).
   */
  readonly severityAfter: SignalSeverity | null;
  readonly severityChange: 'increased' | 'decreased' | 'unchanged' | 'unavailable';
}

/**
 * The advisory regression assessment. `unavailable` when no release
 * correlation exists (no contexts supplied — the repository truth that no
 * release authority exists yet — or every context was rejected):
 * `likelyRegression` is then NULL (explicitly not assessable), never a
 * false `false` (a failure signal never becomes silently healthy).
 */
export interface RegressionAssessment {
  readonly status: 'assessed' | 'unavailable';
  readonly reason: string;
  readonly perRelease: readonly ReleaseRegressionAssessment[];
  /**
   * ADVISORY: true ONLY when at least one correlated release assessed
   * `likely_regression`; null when the assessment is unavailable. This
   * boolean is NOT a verification verdict, NOT a Work Item, NOT a
   * workflow transition — it is an advisory signal attribute consumed by
   * future governed surfaces (WORK-068 / WORK-070).
   */
  readonly likelyRegression: boolean | null;
}

/**
 * The Engineering Signal — the typed, provenance-preserving, advisory
 * record. Immutable per version: ingestion appends occurrences;
 * correlation replaces the correlation/assessment state (recomputed
 * deterministically from the full occurrence set — re-runnable).
 */
export interface EngineeringSignal {
  readonly signalId: string;
  readonly identityFingerprint: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly logicalFailureKey: string;
  /** The DISTINCT sources of the signal's occurrences ("source(s)"). */
  readonly sources: readonly SignalSource[];
  /** The append-only observation history (at least one — never free-floating). */
  readonly occurrences: readonly SignalOccurrence[];
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  /** The severity of the LATEST occurrence (deterministic ordering). */
  readonly latestSeverity: SignalSeverity;
  /** The per-release correlation decisions (empty until correlated). */
  readonly releaseCorrelation: readonly ReleaseCorrelationEntry[];
  /** The advisory regression assessment. */
  readonly regression: RegressionAssessment;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ============================================================================
// §6  The persistence port (the dedup boundary)
// ============================================================================

/**
 * The persistence port for Engineering Signals.
 *
 * ARCHITECTURAL RULING (the WORK-064 run-repository / WORK-066 claim-store
 * precedent): WORK-067's parallel-execution metadata declares `migrations:
 * []` — NO schema migration is authorized by this Work Order. The domain
 * therefore stays at the existing persistence boundary: this PORT with an
 * IN-MEMORY implementation. Durable signal storage is a future
 * architect-authorized ACR binding at this exact port — NOT a parallel
 * evidence/identity/workflow store.
 *
 * The keyed uniqueness contract (the same discipline the real-PG two-actor
 * suite proves): the signal identity fingerprint is the uniqueness key —
 * concurrent saves of the same logical identity converge (occurrence union,
 * deterministic order); the same signalId with a DIFFERENT fingerprint is a
 * typed identity conflict. The DATABASE constraint, not an application
 * race, decides the winner where the durable adapter binds.
 */
export interface EngineeringSignalRepository {
  /**
   * Store (create) or merge a signal version. Create when absent. For an
   * existing signalId with the SAME identity fingerprint: the occurrences
   * merge by occurrenceId (append-only union, deterministic order by
   * (observedAt, recordedAt, occurrenceId)) and the later-updated
   * correlation/assessment state wins (deterministic tie-break) — the
   * correlation state is fully re-derivable through `correlateToReleases`.
   * A same-id/different-fingerprint save is a typed identity conflict.
   */
  save(signal: EngineeringSignal): Promise<EngineeringSignal>;
  /** Read a signal by id. Returns null when absent — never a fabricated signal. */
  findById(signalId: string): Promise<EngineeringSignal | null>;
  /** Read a signal by its identity fingerprint (the dedup lookup). */
  findByIdentityFingerprint(fingerprint: string): Promise<EngineeringSignal | null>;
  /** List the signals recorded for a project (read-only). */
  listByProject(projectId: string): Promise<readonly EngineeringSignal[]>;
}

// ============================================================================
// §7  The release correlation input (RECORDED release identities only)
// ============================================================================

/**
 * A release correlation context — the RECORDED release identity the caller
 * supplies. Repository truth: NO release authority exists yet (no
 * wfos_releases, no release service); the ONLY recorded release references
 * are the WORK-064 authority's POST_RELEASE `releaseRef` records. WORK-067
 * NEVER infers a release identity from a timestamp, a commit, a deployment
 * URL, or a branch name — every release identity arrives here, through
 * this explicit context, with its provenance declared:
 *
 *   - `validation-run-release-ref` — the reference is recorded on WORK-064
 *     POST_RELEASE runs (the existing recorded surface);
 *   - `caller-declared` — a governed caller declared the release identity
 *     (recorded verbatim in the correlation provenance; the weaker basis).
 *
 * When NO contexts are supplied, release correlation is explicitly
 * `unavailable` (fail-closed — the documented architectural gap: the
 * release authority is future architect-gated work, WORK-069 territory).
 */
export interface ReleaseCorrelationContext {
  /** The recorded release reference (non-empty — never invented here). */
  readonly releaseRef: string;
  /** The release boundary time (ISO-8601) — the before/after split point. */
  readonly releasedAt: string;
  /** The release's project scope (must match the signal's project). */
  readonly projectId: string;
  /** How the caller established the release identity (recorded, never inferred). */
  readonly recordedVia: 'validation-run-release-ref' | 'caller-declared';
}

/** The release correlation request. */
export interface CorrelateReleaseInput {
  readonly signalId: string;
  /**
   * The recorded release contexts to correlate against. EMPTY → the
   * correlation is explicitly `unavailable` (fail-closed; the signal stays
   * recorded with its occurrences — never silently healthy).
   */
  readonly releaseContexts: readonly ReleaseCorrelationContext[];
  /** Injectable clock for deterministic tests (defaults to the service clock). */
  readonly now?: () => Date;
}

// ============================================================================
// §8  The service contract (the correlation layer)
// ============================================================================

/** The ingestion outcome vocabulary. */
export const INGEST_OUTCOMES = ['signal-created', 'occurrence-appended', 'duplicate-suppressed'] as const;
export type IngestOutcome = (typeof INGEST_OUTCOMES)[number];

/** The single-observation ingestion result. */
export interface IngestObservationResult {
  /**
   * `signal-created` (a NEW logical failure — first observation),
   * `occurrence-appended` (the same logical failure observed AGAIN at a
   * new time/source — dedup convergence), or `duplicate-suppressed` (the
   * exact same observation re-delivered — idempotent, nothing appended).
   */
  readonly outcome: IngestOutcome;
  readonly signal: EngineeringSignal;
  readonly occurrenceId: string;
}

/** The WORK-064 validation-run ingestion input. */
export interface IngestValidationRunInput {
  /** The COMPLETED validation run id (consumed through the WORK-064 service). */
  readonly runId: string;
  /** The project scope of the run (the run record itself carries no project). */
  readonly projectId: string;
  /** The tenant scope of the run (validated against the run's identity binding). */
  readonly tenantId: string;
  /** Injectable clock for deterministic tests (defaults to the service clock). */
  readonly now?: () => Date;
}

/** The validation-run ingestion result (one outcome per derived observation). */
export interface IngestValidationRunResult {
  /**
   * The per-observation outcomes (empty IFF the run's outcome was
   * `healthy` — a healthy run records NO failure signal, which is the
   * honest no-signal case, NOT a silent conversion: failures ALWAYS
   * produce observations).
   */
  readonly results: readonly IngestObservationResult[];
  /** The WORK-064 run the observations were derived from (provenance). */
  readonly run: ValidationRun;
}

/**
 * The engineering-signal correlation service. The ADVISORY correlation
 * layer: it records signals, deduplicates them, correlates them to
 * recorded release contexts, and assesses likely regression — and it
 * exposes NOTHING that mutates workflow, verification, architecture,
 * review, or code state (static-architecture invariant).
 */
export interface EngineeringSignalService {
  /**
   * The TEMPORARY intake seam: normalize one raw observation, deduplicate
   * it onto its logical signal identity, persist, and return the signal.
   */
  ingestObservation(input: RawObservationInput): Promise<IngestObservationResult>;
  /**
   * Ingest a COMPLETED WORK-064 validation run's failure observations
   * (consumed through the authority's public service: findRun → the typed
   * outcome → the per-failure observations). A healthy run records no
   * failure signal; a failed run's EVERY failure becomes an occurrence.
   */
  ingestValidationRun(input: IngestValidationRunInput): Promise<IngestValidationRunResult>;
  /**
   * Correlate a signal to the recorded release context(s) and assess the
   * likely regression per correlated release (advisory; deterministic;
   * re-runnable — the assessment is recomputed from the full occurrence
   * set each call).
   */
  correlateToReleases(input: CorrelateReleaseInput): Promise<EngineeringSignal>;
  /** Read a signal by id (null when absent — never fabricated). */
  findSignal(signalId: string): Promise<EngineeringSignal | null>;
  /** List the signals recorded for a project (read-only). */
  listSignalsForProject(projectId: string): Promise<readonly EngineeringSignal[]>;
}

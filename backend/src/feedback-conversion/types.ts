/**
 * WORK-068 — Feedback → Governed Work Items: the public domain contracts.
 *
 * The conversion layer lives at `src/feedback-conversion/` (application-
 * layer capability OUTSIDE src/modules/, mirroring the WORK-040
 * development-planner / WORK-064 continuous-validation / WORK-065
 * browser-validation / WORK-066 validation-scheduling / WORK-067
 * engineering-signals precedent — NOT an 18th frozen module) and owns ONLY
 * the feedback-to-governed-Work-Item conversion model:
 *
 *   - assessment: each converted Engineering Signal group is ASSESSED for
 *     severity, scope, and blast radius (discrete, explainable factors —
 *     NO opaque AI score, the WORK-040 prioritizer discipline);
 *   - deduplication: a proposal is matched against the EXISTING OPEN Work
 *     Items of the target architecture version (the deterministic FB- id +
 *     recorded signal provenance); a duplicate converges — it is NEVER
 *     converted into a second Work Item;
 *   - priority: a discrete band assigned RELATIVE to the existing backlog
 *     (the open-item counts + the proposal's rank among the assessed
 *     proposals are recorded as backlog context);
 *   - provenance: every proposal records its originating signal(s) —
 *     signal ids, sources, environments, occurrence references, the
 *     advisory regression outcome — reconstructable, never reduced to a
 *     hash;
 *   - submission: a proposal becomes a Work Item ONLY through the EXISTING
 *     `/work-items` authority's single creation path
 *     (`WorkItemRepository.create`) with the conversion evidence embedded
 *     in the Work Item's existing `metadata` JSONB (field
 *     `metadata.feedbackConversion`) — the WORK-040 planner convention;
 *     this domain owns NO tables and NO parallel work-item store;
 *   - governed decision: the conversion mutation structurally REQUIRES an
 *     explicit ConversionDecision (decidedBy + decisionReason) and ALWAYS
 *     re-derives the assessment in the mutation path — a signal can NEVER
 *     silently become a Work Item without assessment (the WORK-046/062/066
 *     stop-condition discipline).
 *
 * BOUNDARY CONTRACT (spec/work-orders/WORK-068.md — enforced by
 * static-architecture checks):
 *
 *   - NOT a second Work Item authority: the existing `/work-items` module
 *     (wfos_work_items) remains the ONE Work Item authority. This domain
 *     produces PROPOSED Work Items that enter through the EXISTING intake
 *     (WorkItemRepository.create). It declares no parallel WorkItem model,
 *     no work-item repository, no work-item table.
 *   - NOT a second planning authority: the existing continuous development
 *     planner (WORK-040) remains the ONE planning authority. This domain
 *     feeds it — its proposals are planning INPUTS, recorded as such — and
 *     never replaces the planner's prioritization or its backlog.
 *   - NOT a second workflow authority: Work Item lifecycle transitions stay
 *     in `/workflows`. A converted Work Item enters the SAME lifecycle as
 *     any other created Work Item (DRAFT-equivalent created state, no
 *     workflow transition, no checkpoint advance, no execution start, no
 *     review, no merge). The full governance lifecycle — architecture
 *     checkpoint, agent execution, verification, architect review, merge —
 *     still applies before any code change.
 *   - NOT a silent autonomous Work Item creator: the only mutation surface
 *     requires an explicit governed decision; there is NO scheduler, NO
 *     queue, NO signal-ingestion hook, NO autonomous loop (WORK-066 owns
 *     triggers; this domain is never scheduled).
 *   - NOT a code-mutation authority: no signal causes a code change; the
 *     proposal's code path is the full governance lifecycle.
 *   - NOT the signal authority: WORK-067 owns the Engineering Signal
 *     records. This domain CONSUMES them through the WORK-067 public
 *     service (read-only) and never re-implements correlation, dedup of
 *     observations, or regression assessment.
 *   - NOT the progressive-release / architecture-fitness authority
 *     (WORK-069/WORK-070 — downstream consumers of the governed Work
 *     Items this domain produces; not implemented here).
 *   - Determinism: identical (signal set, backlog set, decision, injected
 *     clock) → byte-identical assessments, priorities, proposals, and
 *     created Work Item ids. The clock is injected; identities are sha256
 *     derivations, never random.
 *   - Idempotency: repeated conversion of the same signals converges on
 *     the same deterministic proposal identity (the FB- dedup key); the
 *     existing UNIQUE(architecture_version_id, work_item_id) DB constraint
 *     is the persistence-level dedup fence (the WORK-040 model).
 *   - Fail-closed: missing scope, unknown signal, signal/project mismatch,
 *     a missing decision, a missing decision reason — typed rejections,
 *     never silent success.
 */
import type {
  EngineeringSignalService,
  SignalSeverity,
  SignalSource,
} from '../engineering-signals/index.js';
import type {
  Logger,
} from '@platform/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type {
  ArchitectureVersionRepository,
  ArchitectureRepository,
} from '@modules/architecture/index.js';

// ============================================================================
// §1  The closed vocabularies
// ============================================================================

/**
 * The conversion priority band — the WORK-040 `PlanningPriority` vocabulary
 * (not invented here): 'high' | 'medium' | 'low'. Assigned RELATIVE to the
 * existing backlog (see {@link BacklogContext}).
 */
export const CONVERSION_PRIORITIES = ['high', 'medium', 'low'] as const;
export type ConversionPriority = (typeof CONVERSION_PRIORITIES)[number];

/**
 * The blast-radius band — a DISCRETE, explainable classification of how wide
 * a logical failure's observed spread is:
 *   - 'wide'    — cross-environment AND cross-source confirmation (the same
 *                 logical failure observed in multiple environments and by
 *                 multiple source types), or 10+ occurrences;
 *   - 'moderate'— cross-source OR cross-environment (one spread dimension),
 *                 or 4+ occurrences;
 *   - 'narrow'  — single environment, single source, few occurrences.
 * Never an opaque score: each band records its derivation factors.
 */
export const BLAST_RADIUS_BANDS = ['wide', 'moderate', 'narrow'] as const;
export type BlastRadiusBand = (typeof BLAST_RADIUS_BANDS)[number];

// ============================================================================
// §2  The typed error vocabulary (fail-closed rejections)
// ============================================================================

export const FEEDBACK_CONVERSION_ERROR_CODES = [
  // conversion scope (the required dimensions)
  'CONVERSION_PROJECT_REQUIRED',
  'CONVERSION_ARCHITECTURE_VERSION_REQUIRED',
  'CONVERSION_ORGANIZATION_REQUIRED',
  // signal selection + consumption
  'CONVERSION_SIGNAL_IDS_INVALID',
  'CONVERSION_SIGNAL_NOT_FOUND',
  'CONVERSION_SIGNAL_PROJECT_MISMATCH',
  // the governed decision boundary (no silent conversion)
  'CONVERSION_DECISION_REQUIRED',
  'CONVERSION_DECISION_DECIDED_BY_REQUIRED',
  'CONVERSION_DECISION_REASON_REQUIRED',
  // assessment integrity
  'CONVERSION_ASSESSMENT_REQUIRED',
  'CONVERSION_LOGICAL_KEY_REQUIRED',
  'CONVERSION_PROVENANCE_REQUIRED',
  // dedup boundary
  'CONVERSION_OPEN_ITEMS_UNAVAILABLE',
] as const;
export type FeedbackConversionErrorCode = (typeof FEEDBACK_CONVERSION_ERROR_CODES)[number];

/** The typed domain error (discriminated by `code`). */
export class FeedbackConversionError extends Error {
  constructor(
    readonly code: FeedbackConversionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeedbackConversionError';
  }
}

// ============================================================================
// §3  The governed decision (the no-silent-creation boundary)
// ============================================================================

/**
 * The explicit, governed conversion decision — REQUIRED by the mutation
 * surface. A signal NEVER becomes a Work Item without one:
 *
 *   - `decidedBy` — the principal that decided (the authenticated user id
 *     on the public route — server-resolved, never caller-supplied; a
 *     trusted internal producer on the programmatic path);
 *   - `decisionReason` — the recorded, non-empty reason (the governance
 *     trail: why these signals are worth governed work).
 *
 * This is the WORK-046/062/066 stop-condition discipline: conversion is a
 * DECISION, recorded with its provenance, not an automatic consequence of
 * a signal existing.
 */
export interface ConversionDecision {
  readonly decidedBy: string;
  readonly decisionReason: string;
}

/** The recorded decision (the persisted provenance of the decision). */
export interface ConversionDecisionRecord extends ConversionDecision {
  /** ISO-8601 — the injected clock's value at decision time (never a wall-clock read). */
  readonly decidedAt: string;
}

// ============================================================================
// §4  The assessment model (severity / scope / blast radius)
// ============================================================================

/** A discrete, explainable assessment factor (the WORK-040 factor discipline). */
export interface ConversionAssessmentFactor {
  readonly kind:
    | 'signal-severity'
    | 'regression-evidence'
    | 'cross-source-confirmation'
    | 'cross-environment-spread'
    | 'occurrence-frequency'
    | 'observation-recency';
  readonly weight: number;
  readonly detail: string;
}

/**
 * The assessed blast radius + its derivation (discrete band + factors).
 */
export interface BlastRadiusAssessment {
  readonly band: BlastRadiusBand;
  readonly factors: readonly ConversionAssessmentFactor[];
  /** The distinct environments the logical failure was observed in. */
  readonly environmentIds: readonly string[];
  /** The distinct source types that observed the logical failure. */
  readonly sources: readonly SignalSource[];
  /** The total occurrence count across the group's signals. */
  readonly occurrenceCount: number;
}

/**
 * The full signal-group assessment: severity (the recorded truth +
 * escalation evidence), scope (the observed spread), blast radius (the
 * discrete band + factors). ASSESSMENT IS ALWAYS DERIVED — never
 * caller-supplied, never skipped: the mutation path re-derives it before
 * any Work Item is created.
 */
export interface SignalGroupAssessment {
  /** The RECORDED latest severity of the group's most-severe signal (never promoted). */
  readonly latestSeverity: SignalSeverity;
  /** The peak recorded severity across the group's occurrences. */
  readonly peakSeverity: SignalSeverity;
  /** The advisory regression evidence, recorded verbatim per signal (WORK-067 truth). */
  readonly regressionOutcomes: readonly SignalRegressionEvidence[];
  readonly blastRadius: BlastRadiusAssessment;
  readonly factors: readonly ConversionAssessmentFactor[];
  /** The reconstructable assessment reasoning (never silent). */
  readonly reason: string;
}

/**
 * The per-signal advisory regression evidence — recorded VERBATIM from the
 * WORK-067 assessment (never re-interpreted, never promoted to a verdict).
 */
export interface SignalRegressionEvidence {
  readonly signalId: string;
  readonly environmentId: string;
  readonly likelyRegression: boolean | null;
}

// ============================================================================
// §5  The proposal (the assessed, deduplicated, prioritized candidate)
// ============================================================================

/**
 * The deterministic proposal identity: `FB-<10 hex>` — sha256 over the
 * canonical proposal scope (organizationId | projectId |
 * architectureVersionId | logicalFailureKey). The DEDUP KEY: the same
 * logical failure in the same target version converges on the same FB- id
 * → the same Work Item (never a second one). Cross-environment signals of
 * the same logical failure MERGE into one proposal (the Work Item's dedup
 * dimension is the logical failure at project scope, not the environment).
 */
export interface ProposalIdentity {
  readonly proposalId: string;
  readonly identityFingerprint: string;
}

/** The dedup outcome against the existing open Work Items. */
export type ProposalDedupOutcome =
  | 'no-open-match'
  | 'open-proposal-id-match'
  | 'open-signal-provenance-match';

/** The backlog context — the RELATIVE priority record. */
export interface BacklogContext {
  /** The count of OPEN Work Items in the target architecture version at assessment time. */
  readonly openWorkItemCount: number;
  /** The proposal's rank among the assessed proposals (1 = highest priority score, deterministic). */
  readonly rankAmongAssessedProposals: number;
  /** The total assessed proposals in this evaluation. */
  readonly assessedProposalCount: number;
}

/** A discrete, explainable priority factor (the WORK-040 discipline). */
export interface ConversionPriorityFactor {
  readonly kind:
    | 'severity-escalation'
    | 'regression-evidence'
    | 'blast-radius-wide'
    | 'blast-radius-moderate'
    | 'cross-source-confirmation'
    | 'occurrence-frequency'
    | 'backlog-pressure';
  readonly weight: number;
  readonly detail: string;
}

/**
 * The conversion proposal — ONE assessed, deduplicated, prioritized
 * proposal derived from the signal group. This is DERIVED STATE (never
 * durably stored in this domain): it either becomes a Work Item through
 * the existing `/work-items` intake or it converges/deduplicates. The
 * domain owns NO proposal table.
 */
export interface ConversionProposal {
  readonly identity: ProposalIdentity;
  /** The originating signal ids — NEVER empty (no free-floating proposals). */
  readonly sourceSignalIds: readonly string[];
  readonly logicalFailureKey: string;
  readonly assessment: SignalGroupAssessment;
  readonly priority: ConversionPriority;
  readonly priorityFactors: readonly ConversionPriorityFactor[];
  readonly backlogContext: BacklogContext;
  readonly title: string;
  readonly objective: string;
  readonly scope: string;
  /** The dedup decision against the existing OPEN Work Items. */
  readonly dedup: {
    readonly outcome: ProposalDedupOutcome;
    /** The matching OPEN Work Item ids (present when outcome ≠ 'no-open-match'). */
    readonly matchedOpenWorkItemIds: readonly string[];
  };
  /** Completed FB- items covering the same logical failure (recurrence provenance). */
  readonly recurrenceOf: readonly string[];
  /** The first/last observation times across the group (recorded values). */
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

// ============================================================================
// §6  The provenance payload (embedded in the Work Item's metadata)
// ============================================================================

/**
 * The conversion evidence embedded in the created Work Item's existing
 * `metadata.feedbackConversion` JSONB field — NOT a new column / table
 * (the WORK-040 `metadata.planner` convention). Records the full
 * signal→Work-Item provenance chain: the originating signal ids, their
 * sources and environments, the occurrence references, the assessment,
 * the priority + backlog context, the dedup key, the advisory regression
 * evidence, the recurrence chain, and the GOVERNED DECISION that created
 * it.
 */
export interface FeedbackConversionMetadataPayload {
  readonly conversionVersion: string;
  readonly sourceSignalIds: readonly string[];
  readonly logicalFailureKey: string;
  /** The distinct sources across the group's signals. */
  readonly sourceSources: readonly SignalSource[];
  readonly environmentIds: readonly string[];
  readonly occurrenceCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly latestSeverity: SignalSeverity;
  readonly peakSeverity: SignalSeverity;
  /** The advisory regression evidence — verbatim, never a verdict. */
  readonly regressionOutcomes: readonly SignalRegressionEvidence[];
  /** The derived assessment (severity/scope/blast radius + factors). */
  readonly assessment: SignalGroupAssessment;
  readonly priority: ConversionPriority;
  readonly priorityFactors: readonly ConversionPriorityFactor[];
  readonly backlogContext: BacklogContext;
  readonly dedupKey: string;
  readonly recurrenceOf: readonly string[];
  /** The governed decision that produced this Work Item (never silent). */
  readonly decision: ConversionDecisionRecord;
  /**
   * The recorded pointer to the raw occurrence references — the
   * reconstructable causal chain (each entry: the WORK-067 occurrence id +
   * its source observation reference). Never reduced to a hash.
   */
  readonly occurrenceProvenance: readonly OccurrenceProvenanceEntry[];
}

/** One raw-observation provenance entry (preserved, never dereferenced here). */
export interface OccurrenceProvenanceEntry {
  readonly signalId: string;
  readonly occurrenceId: string;
  readonly source: SignalSource;
  readonly observedAt: string;
  /** The WORK-067 observation reference, preserved verbatim. */
  readonly observationRef: { readonly kind: string; readonly ref: string; readonly detail?: string };
}

// ============================================================================
// §7  The conversion input / result (the service contract)
// ============================================================================

/** The shared evaluation input (both assessment and conversion). */
export interface ConversionEvaluationInput {
  readonly projectId: string;
  /**
   * The TARGET architecture version the created Work Items belong to (the
   * existing traceability chain: Work Item → ArchitectureVersion →
   * Architecture → Project — the WORK-040 contract).
   */
  readonly architectureVersionId: string;
  /**
   * The explicit subset of signal ids to evaluate (the project's signals
   * by default). Each must exist + belong to the project (fail-closed).
   */
  readonly signalIds?: readonly string[];
  /** Injectable clock for deterministic tests (defaults to the service clock). */
  readonly now?: () => Date;
}

/** The per-proposal conversion outcome. */
export type ProposalConversionOutcome =
  | 'created'
  | 'deduplicated'
  | 'conversion-failed';

/** One converted (or converged) proposal + its outcome. */
export interface ProposalConversionResult {
  readonly proposal: ConversionProposal;
  readonly outcome: ProposalConversionOutcome;
  /**
   * The authoritative wfos_work_items.id — present when the outcome is
   * 'created' or 'deduplicated' (the dedup target).
   */
  readonly workItemRecordId?: string;
  /** The authoritative wfos_work_items.work_item_id (e.g. FB-a1b2c3d4e5). */
  readonly workItemHumanId?: string;
  /** Present when outcome is 'conversion-failed' — nothing landed. */
  readonly failureReason?: string;
}

/** The assessment result (READ-ONLY — never mutates anything). */
export interface AssessmentResult {
  readonly proposals: readonly ConversionProposal[];
  readonly architectureVersionId: string;
  readonly projectId: string;
  /** The signals evaluated (their ids — the provenance of this assessment). */
  readonly evaluatedSignalIds: readonly string[];
}

/** The conversion result (the governed mutation's record). */
export interface ConversionResult {
  readonly results: readonly ProposalConversionResult[];
  readonly architectureVersionId: string;
  readonly projectId: string;
  /** The recorded decision (the governance trail). */
  readonly decision: ConversionDecisionRecord;
  readonly createdCount: number;
  readonly deduplicatedCount: number;
  readonly failedCount: number;
}

// ============================================================================
// §8  The resolution context + the service contract
// ============================================================================

/**
 * The read-only authority handles the conversion needs. The domain holds NO
 * credentials, imports NO module internal/ (statically enforced), and
 * mutates ONLY through `workItemRepository.create` (the single Work Item
 * creation path — the existing `/work-items` intake). The /architecture
 * handles validate the target version's ownership (a UUID is NEVER a
 * credential — the WORK-040 discipline: the service itself verifies the
 * architecture version belongs to the project before anything is
 * assessed or created).
 */
export interface ConversionContext {
  readonly organizationId: string;
  readonly projectId: string;
  /** The WORK-067 authority (read-only consumption: listSignalsForProject / findSignal). */
  readonly engineeringSignalService: EngineeringSignalService;
  /** The EXISTING /work-items authority intake (create + read for dedup). */
  readonly workItemRepository: WorkItemRepository;
  /** The /architecture read handles (target-version ownership validation). */
  readonly architectureVersionRepository: ArchitectureVersionRepository;
  readonly architectureRepository: ArchitectureRepository;
  readonly logger: Logger;
}

/**
 * The feedback-conversion service — the WORK-068 conversion layer.
 *
 * SURFACE CONTRACT (statically pinned): exactly TWO methods —
 *
 *   - `assessSignals`  — READ-ONLY. No mutation of ANY authority (the
 *     recording-repository discrimination proves it). Produces the
 *     assessed, deduplicated, prioritized proposals WITHOUT creating
 *     anything.
 *   - `convertSignals` — MUTATION. Requires the explicit governed
 *     ConversionDecision; re-derives the assessment in the mutation path
 *     (a signal can never become a Work Item without assessment); creates
 *     Work Items THROUGH the existing WorkItemRepository.create only.
 *
 * The service exposes NO other surface: no scheduling, no ingestion, no
 * workflow/verification/review/architecture mutation, no dependency-graph
 * mutation, no execution start, no provider selection.
 */
export interface FeedbackConversionService {
  /**
   * READ-ONLY — never creates / mutates. Assess the project's engineering
   * signals: severity / scope / blast radius, dedup against the existing
   * OPEN Work Items, priority relative to the backlog. The GET surface
   * uses this so a read-authorized caller can NEVER trigger a mutation.
   */
  assessSignals(
    input: ConversionEvaluationInput,
    ctx: ConversionContext,
  ): Promise<AssessmentResult>;

  /**
   * MUTATION — requires an explicit governed decision. Re-derives the
   * assessment (the conversion pipeline ALWAYS includes assessment — no
   * silent creation), re-checks dedup (fail-closed against races), and
   * creates the Work Items through the EXISTING /work-items
   * WorkItemRepository.create (metadata.feedbackConversion embedded).
   * Convergent + idempotent: the deterministic FB- proposal id + the
   * existing UNIQUE(architecture_version_id, work_item_id) DB constraint
   * fence concurrent runs — a concurrent duplicate INSERT throws
   * unique-violation → re-query → converge (the WORK-040 model).
   */
  convertSignals(
    input: ConversionEvaluationInput & { decision: ConversionDecision },
    ctx: ConversionContext,
  ): Promise<ConversionResult>;
}

/** The composition defaults' dependencies (constructor input). */
export interface FeedbackConversionServiceDeps {
  readonly logger: Logger;
  /** The REQUIRED injected clock (no implicit global time in the domain path). */
  readonly now: () => Date;
}

// ============================================================================
// §9  Re-exports of the consumed authority types (single import surface)
// ============================================================================

export type { EngineeringSignal, SignalSeverity, SignalSource } from '../engineering-signals/index.js';
export type { WorkItem } from '@modules/work-items/index.js';

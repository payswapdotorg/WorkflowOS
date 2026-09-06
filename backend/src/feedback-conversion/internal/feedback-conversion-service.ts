/**
 * WORK-068 — DefaultFeedbackConversionService: the conversion orchestrator.
 *
 * AUTHORITY BOUNDARY (enforced statically in static-architecture.test.ts):
 *   * The service CREATES Work Items ONLY via the existing
 *     WorkItemRepository.create (the single creation path — the existing
 *     /work-items intake). It NEVER calls update/markCompleted (the
 *     completion signal is the workflow/verification-derived fact), NEVER
 *     mutates the dependency graph, NEVER transitions workflow state,
 *     NEVER creates/approves/merges PRs, NEVER starts execution, NEVER
 *     selects a provider.
 *   * The domain owns NO tables: the conversion evidence is embedded in
 *     the authoritative Work Item's existing `metadata` JSONB (field
 *     `metadata.feedbackConversion`). The authoritative Work Item state
 *     stays in wfos_work_items.
 *
 * THE GOVERNED DECISION BOUNDARY (no silent autonomous creation):
 *   * `assessSignals` is READ-ONLY (no mutation of any authority — the
 *     recording-repository discrimination proves it).
 *   * `convertSignals` REQUIRES an explicit ConversionDecision and
 *     re-derives the assessment IN the mutation path — a signal can never
 *     become a Work Item without assessment, and conversion never happens
 *     without a decision (the WORK-046/062/066 stop-condition discipline).
 *
 * DEDUP / CONCURRENCY MODEL (the WORK-040 model):
 *   1. the deterministic proposal id (FB-<sha256 scope>) is the dedup key;
 *   2. the application-level pre-check matches the target version's OPEN
 *      Work Items (proposal-id + signal-provenance matches converge);
 *   3. the existing UNIQUE(architecture_version_id, work_item_id) DB
 *      constraint is the persistence-level fence — a concurrent duplicate
 *      INSERT throws unique-violation → re-query → CONVERGE.
 */
import {
  FeedbackConversionError,
  type AssessmentResult,
  type ConversionContext,
  type ConversionDecision,
  type ConversionDecisionRecord,
  type ConversionEvaluationInput,
  type ConversionProposal,
  type ConversionResult,
  type FeedbackConversionService,
  type FeedbackConversionServiceDeps,
  type ProposalConversionResult,
} from '../types.js';
import { deriveProposalIdentity } from './conversion-identity.js';
import { assessSignalGroup, earliestObservationTime, latestObservationTime, occurrenceProvenanceOf } from './signal-assessment.js';
import { matchOpenWorkItems, deriveCreationId, isSameProposalFamily, FEEDBACK_CONVERSION_METADATA_FIELD } from './open-work-item-matcher.js';
import { deriveBacklogContext, prioritizeProposal, priorityScore } from './conversion-prioritizer.js';
import type { EngineeringSignal } from '../../engineering-signals/index.js';

/** The conversion model version (recorded in every metadata payload). */
export const FEEDBACK_CONVERSION_VERSION = 'WORK-068/1.0.0';

/**
 * Detect whether a thrown error is a PostgreSQL unique-violation
 * (SQLSTATE 23505) — the WORK-040 convergence seam (driver-decoupled).
 */
function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === '23505';
}

/** Require a non-empty string (the fail-closed scope discipline). */
function requireNonEmpty(value: string | undefined, code: 'CONVERSION_PROJECT_REQUIRED' | 'CONVERSION_ARCHITECTURE_VERSION_REQUIRED', what: string): string {
  if (!value || value.trim() === '') {
    throw new FeedbackConversionError(code, `${what} is required (fail-closed — never a silent default scope)`);
  }
  return value;
}

/** Validate the governed decision (the no-silent-creation boundary). */
function requireValidDecision(decision: ConversionDecision | undefined): ConversionDecision {
  if (!decision || typeof decision !== 'object') {
    throw new FeedbackConversionError(
      'CONVERSION_DECISION_REQUIRED',
      'the conversion mutation requires an explicit governed decision (decidedBy + decisionReason) — a signal never becomes a Work Item silently',
    );
  }
  if (!decision.decidedBy || decision.decidedBy.trim() === '') {
    throw new FeedbackConversionError(
      'CONVERSION_DECISION_DECIDED_BY_REQUIRED',
      'the conversion decision requires the deciding principal (decidedBy)',
    );
  }
  if (!decision.decisionReason || decision.decisionReason.trim() === '') {
    throw new FeedbackConversionError(
      'CONVERSION_DECISION_REASON_REQUIRED',
      'the conversion decision requires a non-empty recorded reason (the governance trail)',
    );
  }
  return decision;
}

/**
 * Load + select the project's signals through the WORK-067 authority
 * (read-only consumption). Fail-closed: an unknown requested signal id or
 * a project mismatch is a typed rejection — never a silently-empty
 * conversion.
 */
async function loadProjectSignals(
  input: ConversionEvaluationInput,
  ctx: ConversionContext,
): Promise<readonly EngineeringSignal[]> {
  const signals = await ctx.engineeringSignalService.listSignalsForProject(input.projectId);
  if (!input.signalIds || input.signalIds.length === 0) {
    return signals;
  }
  if (!Array.isArray(input.signalIds) || input.signalIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new FeedbackConversionError(
      'CONVERSION_SIGNAL_IDS_INVALID',
      'signalIds must be an array of non-empty signal ids',
    );
  }
  const byId = new Map(signals.map((signal) => [signal.signalId, signal]));
  const selected: EngineeringSignal[] = [];
  for (const signalId of input.signalIds) {
    const signal = byId.get(signalId);
    if (!signal) {
      throw new FeedbackConversionError(
        'CONVERSION_SIGNAL_NOT_FOUND',
        `signal '${signalId}' was not found among the project's recorded signals (fail-closed — never a fabricated signal)`,
      );
    }
    if (signal.projectId !== input.projectId) {
      throw new FeedbackConversionError(
        'CONVERSION_SIGNAL_PROJECT_MISMATCH',
        `signal '${signalId}' belongs to project '${signal.projectId}' (scope mismatch with '${input.projectId}')`,
      );
    }
    selected.push(signal);
  }
  return selected;
}

/**
 * Validate the target architecture version's ownership (a UUID is NEVER a
 * credential — the WORK-040 discipline): the version must exist and its
 * architecture must belong to the conversion's project. Fail-closed.
 */
async function requireVersionOwnership(
  input: { architectureVersionId: string; projectId: string },
  ctx: ConversionContext,
): Promise<void> {
  const version = await ctx.architectureVersionRepository.findById(input.architectureVersionId);
  if (!version) {
    throw new Error('conversion-architecture-version-not-found');
  }
  const architecture = await ctx.architectureRepository.findById(version.architectureId);
  if (!architecture || architecture.projectId !== input.projectId) {
    throw new Error('conversion-architecture-version-not-in-project');
  }
}

/**
 * Derive the proposals: group the signals by logicalFailureKey (cross-
 * environment signals of the same logical failure MERGE into one proposal
 * — the Work Item dedup dimension is the logical failure at project
 * scope), assess each group, dedup against the OPEN Work Items, prioritize
 * relative to the backlog, rank deterministically. PURE over (signals,
 * open items) — the assessment core shared by BOTH the read-only assess
 * path and the mutating convert path (the mutation path re-derives it —
 * assessment can never be skipped).
 */
async function deriveProposals(
  input: ConversionEvaluationInput,
  ctx: ConversionContext,
): Promise<readonly ConversionProposal[]> {
  // The target architecture version's ownership FIRST (fail-closed — a
  // UUID is never a credential; both the assess and the convert paths
  // validate it before anything is derived or created).
  await requireVersionOwnership(input, ctx);
  const signals = await loadProjectSignals(input, ctx);
  if (signals.length === 0) {
    return [];
  }
  const workItems = await ctx.workItemRepository.findByArchitectureVersion(input.architectureVersionId);

  // Group by logicalFailureKey (deterministic order: key ASC).
  const groups = new Map<string, EngineeringSignal[]>();
  for (const signal of signals) {
    const group = groups.get(signal.logicalFailureKey) ?? [];
    group.push(signal);
    groups.set(signal.logicalFailureKey, group);
  }
  const sortedKeys = [...groups.keys()].sort();

  // Pass 1: assess + dedup (identity + open-item match).
  const assessed = sortedKeys.map((logicalFailureKey) => {
    const group = groups.get(logicalFailureKey)!;
    const identity = deriveProposalIdentity({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      architectureVersionId: input.architectureVersionId,
      logicalFailureKey,
    });
    const sourceSignalIds = group.map((signal) => signal.signalId);
    const assessment = assessSignalGroup(group);
    const dedup = matchOpenWorkItems({
      proposalId: identity.proposalId,
      sourceSignalIds,
      workItems,
    });
    return { logicalFailureKey, group, identity, sourceSignalIds, assessment, dedup };
  });

  // Pass 2: prioritize + rank (deterministic: score DESC, key ASC).
  const openWorkItemCount = workItems.filter((item) => item.completed === false).length;
  const prioritized = assessed.map((entry) => {
    const prioritization = prioritizeProposal({ assessment: entry.assessment, openWorkItemCount });
    return { ...entry, priority: prioritization.priority, priorityFactors: prioritization.factors };
  });
  const ranked = [...prioritized].sort((a, b) => {
    const byScore = priorityScore(b.priorityFactors) - priorityScore(a.priorityFactors);
    if (byScore !== 0) return byScore;
    return a.logicalFailureKey < b.logicalFailureKey ? -1 : a.logicalFailureKey > b.logicalFailureKey ? 1 : 0;
  });

  // Pass 3: the proposals (title/objective/scope derived deterministically
  // from the recorded signal truth — never caller-supplied).
  return ranked.map((entry) => {
    const backlogContext = deriveBacklogContext({
      openWorkItemCount,
      rankedProposals: ranked.map((proposal) => ({
        logicalFailureKey: proposal.logicalFailureKey,
        factors: proposal.priorityFactors,
      })),
      logicalFailureKey: entry.logicalFailureKey,
    });
    const blast = entry.assessment.blastRadius;
    return {
      identity: entry.identity,
      sourceSignalIds: entry.sourceSignalIds,
      logicalFailureKey: entry.logicalFailureKey,
      assessment: entry.assessment,
      priority: entry.priority,
      priorityFactors: entry.priorityFactors,
      backlogContext,
      title: `Address engineering signal: ${entry.logicalFailureKey}`,
      objective:
        `Convert the assessed engineering signal(s) into governed work — ${entry.assessment.reason} ` +
        `The proposal enters through the existing /work-items intake and still requires the full governance lifecycle before any code change.`,
      scope:
        `The logical failure '${entry.logicalFailureKey}' observed in ${blast.environmentIds.length} environment(s) ` +
        `(${blast.environmentIds.join(', ')}) by ${blast.sources.length} source type(s) (${blast.sources.join(', ')}) ` +
        `across ${blast.occurrenceCount} recorded occurrence(s); the assessed blast radius is '${blast.band}'.`,
      dedup: {
        outcome: entry.dedup.outcome,
        matchedOpenWorkItemIds: entry.dedup.matchedOpenWorkItemIds,
      },
      recurrenceOf: entry.dedup.recurrenceOf,
      firstObservedAt: earliestObservationTime(entry.group),
      lastObservedAt: latestObservationTime(entry.group),
    } satisfies ConversionProposal;
  });
}

/** The deterministic architecture-impact declaration (WORK-051): derived from the blast radius band, recorded in the metadata. */
function deriveArchitectureImpact(band: 'wide' | 'moderate' | 'narrow'): 'high' | 'medium' | 'low' {
  return band === 'wide' ? 'high' : band === 'moderate' ? 'medium' : 'low';
}

export class DefaultFeedbackConversionService implements FeedbackConversionService {
  private readonly logger: FeedbackConversionServiceDeps['logger'];
  private readonly now: () => Date;

  constructor(deps: FeedbackConversionServiceDeps) {
    this.logger = deps.logger;
    this.now = deps.now;
  }

  async assessSignals(
    input: ConversionEvaluationInput,
    ctx: ConversionContext,
  ): Promise<AssessmentResult> {
    const projectId = requireNonEmpty(input.projectId, 'CONVERSION_PROJECT_REQUIRED', 'the project id');
    const architectureVersionId = requireNonEmpty(
      input.architectureVersionId,
      'CONVERSION_ARCHITECTURE_VERSION_REQUIRED',
      'the target architecture version id',
    );
    const proposals = await deriveProposals(
      { ...input, projectId, architectureVersionId },
      ctx,
    );
    return {
      proposals,
      architectureVersionId,
      projectId,
      evaluatedSignalIds: proposals.flatMap((proposal) => [...proposal.sourceSignalIds]),
    };
  }

  async convertSignals(
    input: ConversionEvaluationInput & { decision: ConversionDecision },
    ctx: ConversionContext,
  ): Promise<ConversionResult> {
    const projectId = requireNonEmpty(input.projectId, 'CONVERSION_PROJECT_REQUIRED', 'the project id');
    const architectureVersionId = requireNonEmpty(
      input.architectureVersionId,
      'CONVERSION_ARCHITECTURE_VERSION_REQUIRED',
      'the target architecture version id',
    );
    // THE GOVERNED DECISION BOUNDARY — validated BEFORE anything is loaded
    // or created (fail-closed: no decision, no mutation).
    const decision = requireValidDecision(input.decision);
    const decidedAt = this.now().toISOString();
    const decisionRecord: ConversionDecisionRecord = {
      decidedBy: decision.decidedBy,
      decisionReason: decision.decisionReason,
      decidedAt,
    };

    // THE ASSESSMENT IS RE-DERIVED IN THE MUTATION PATH — the conversion
    // pipeline structurally includes assessment (a signal can never become
    // a Work Item without it).
    const proposals = await deriveProposals(
      { ...input, projectId, architectureVersionId },
      ctx,
    );

    const results: ProposalConversionResult[] = [];
    for (const proposal of proposals) {
      // The dedup boundary: an OPEN match converges — NEVER a second Work Item.
      if (proposal.dedup.outcome !== 'no-open-match') {
        const matchedId = proposal.dedup.matchedOpenWorkItemIds[0];
        const matched = matchedId ? await ctx.workItemRepository.findById(matchedId) : undefined;
        results.push({
          proposal,
          outcome: 'deduplicated',
          workItemRecordId: matched?.id ?? matchedId,
          workItemHumanId: matched?.workItemId ?? proposal.identity.proposalId,
        });
        continue;
      }

      // The PROPOSED Work Item — submitted through the EXISTING /work-items
      // intake (WorkItemRepository.create, the single creation path), with
      // the full provenance embedded in the existing metadata JSONB.
      const metadataPayload = {
        conversionVersion: FEEDBACK_CONVERSION_VERSION,
        sourceSignalIds: [...proposal.sourceSignalIds],
        logicalFailureKey: proposal.logicalFailureKey,
        sourceSources: [...proposal.assessment.blastRadius.sources],
        environmentIds: [...proposal.assessment.blastRadius.environmentIds],
        occurrenceCount: proposal.assessment.blastRadius.occurrenceCount,
        firstObservedAt: proposal.firstObservedAt,
        lastObservedAt: proposal.lastObservedAt,
        latestSeverity: proposal.assessment.latestSeverity,
        peakSeverity: proposal.assessment.peakSeverity,
        regressionOutcomes: [...proposal.assessment.regressionOutcomes],
        assessment: proposal.assessment,
        priority: proposal.priority,
        priorityFactors: [...proposal.priorityFactors],
        backlogContext: proposal.backlogContext,
        dedupKey: proposal.identity.proposalId,
        recurrenceOf: [...proposal.recurrenceOf],
        decision: decisionRecord,
        occurrenceProvenance: occurrenceProvenanceOf(await loadGroupSignals(ctx, proposal.sourceSignalIds)),
      };

      try {
        // The CREATION id: the base deterministic FB- id, or the recurrence
        // generation (FB-<10 hex>.R2, .R3, …) when completed family items
        // exist — the recurrence is a DISTINCT Work Item (the existing
        // UNIQUE constraint stays intact).
        const { creationId } = deriveCreationId({
          proposalId: proposal.identity.proposalId,
          recurrenceOf: proposal.recurrenceOf,
          workItems: await ctx.workItemRepository.findByArchitectureVersion(architectureVersionId),
        });
        const created = await ctx.workItemRepository.create({
          architectureVersionId,
          workItemId: creationId,
          title: proposal.title,
          objective: proposal.objective,
          scope: proposal.scope,
          outOfScope:
            'the signal correlation model (WORK-067 — the advisory signal authority); ' +
            'the progressive release decisions (WORK-069); the architecture fitness model (WORK-070)',
          architectureConstraints:
            'The existing /work-items authority remains the ONE Work Item authority. ' +
            'This Work Item still requires the full governance lifecycle (architecture checkpoint, ' +
            'agent execution, verification, architect review, merge) before any code change.',
          architectureImpact: deriveArchitectureImpact(proposal.assessment.blastRadius.band),
          metadata: { [FEEDBACK_CONVERSION_METADATA_FIELD]: metadataPayload },
        });
        results.push({
          proposal,
          outcome: 'created',
          workItemRecordId: created.id,
          workItemHumanId: created.workItemId,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          // A concurrent conversion created the same (architecture_version_id,
          // work_item_id) between our load and our insert → re-query → CONVERGE
          // (the WORK-040 model; the DB constraint is the hard guarantee).
          const existing = (await ctx.workItemRepository.findByArchitectureVersion(architectureVersionId))
            .find((item) => isSameProposalFamily(item.workItemId, proposal.identity.proposalId));
          if (existing) {
            results.push({
              proposal,
              outcome: 'deduplicated',
              workItemRecordId: existing.id,
              workItemHumanId: existing.workItemId,
            });
            continue;
          }
        }
        // Any other failure: NOTHING landed — the create threw; record it
        // honestly (no false Work Item).
        this.logger.warn(
          'WORK-068 conversion failed honestly (nothing landed)',
          { logicalFailureKey: proposal.logicalFailureKey, error: err instanceof Error ? err.message : String(err) },
        );
        results.push({
          proposal,
          outcome: 'conversion-failed',
          failureReason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      results,
      architectureVersionId,
      projectId,
      decision: decisionRecord,
      createdCount: results.filter((result) => result.outcome === 'created').length,
      deduplicatedCount: results.filter((result) => result.outcome === 'deduplicated').length,
      failedCount: results.filter((result) => result.outcome === 'conversion-failed').length,
    };
  }

}

/** Load the proposal's originating signals (for the occurrence provenance — preserved verbatim). */
async function loadGroupSignals(
  ctx: ConversionContext,
  signalIds: readonly string[],
): Promise<readonly EngineeringSignal[]> {
  const signals: EngineeringSignal[] = [];
  for (const signalId of signalIds) {
    const signal = await ctx.engineeringSignalService.findSignal(signalId);
    if (signal) signals.push(signal);
  }
  return signals;
}

/** The honest WORK-068 conversion metadata type pin (the embedded provenance payload shape). */
export type { FeedbackConversionMetadataPayload } from '../types.js';

/**
 * WORK-040: Default Continuous Development Planner service — the orchestrator
 * that COMPOSES the EXISTING domain authorities (/work-items, /architecture,
 * /requirements, /projects) to decide "what should be done next?" and
 * convergently create authoritative Work Items THROUGH the existing
 * /work-items WorkItemRepository.create.
 *
 * AUTHORITY BOUNDARY (enforced statically in static-architecture.test.ts):
 *   * The planner CREATES Work Items via the existing WorkItemRepository.create
 *     (the single creation path). It NEVER calls workItemDependencyRepository.add
 *     / remove (the dependency graph is mutated ONLY through the existing
 *     /work-items/dependencies route). It NEVER calls workflowRepository.*,
 *     verificationRepository.*, reviewRepository.* (those authorities are
 *     untouched). It NEVER calls executionService.start / selects a provider.
 *   * The planner owns NO tables. The planning evidence is embedded in the
 *     authoritative Work Item's existing `metadata` JSONB (field
 *     `metadata.planner`). The authoritative Work Item state stays in
 *     wfos_work_items.
 *
 * DEDUP / CONCURRENCY MODEL. The planner computes a deterministic
 * proposedWorkItemId per signal. The existing
 * UNIQUE(architecture_version_id, work_item_id) DB constraint is the
 * persistence-level dedup fence. The orchestrator's evaluate:
 *   1. loads the existing Work Items in the target version (for the dedup map);
 *   2. for each signal → prioritizer.prioritize → candidate;
 *   3. if the candidate's proposedWorkItemId already exists in the map →
 *      'already-exists' (converge; NO mutation of the existing item);
 *   4. else → workItemRepository.create (with metadata.planner embedded);
 *      on success → 'created'; on a unique-violation (a concurrent run created
 *      the same id between our load + our insert) → re-query → 'already-exists'
 *      (converge); on any other error → 'evaluation-failed' (NO false Work Item
 *      created — the create threw, nothing landed).
 *
 * The planner NEVER relies on application-level "check-then-insert" alone — the
 * DB constraint is the hard guarantee.
 */
import type {
  DevelopmentPlannerService,
  DevelopmentPlannerServiceDeps,
  PlanningCandidate,
  PlanningContext,
  PlanningEvaluateInput,
  PlanningEvaluateResult,
  PlanningMetadataPayload,
  PlanningRecommendation,
  PlanningRecommendationSummary,
} from '../development-planner.types.js';
import type { WorkItem } from '@modules/work-items/index.js';
import { computeProposedWorkItemId, computeCanonicalGoalHash } from './deterministic-planning-prioritizer.js';

/**
 * Detect whether a thrown error is a PostgreSQL unique-violation (SQLSTATE
 * 23505). The pg driver stamps `code` on errors; we do NOT couple to the
 * driver type — we read the `code` property defensively. A unique-violation on
 * wfos_work_items means a concurrent planner run created the same
 * (architecture_version_id, work_item_id) between our load + our insert → we
 * catch + re-query → CONVERGE (no duplicate, no failure).
 */
function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === '23505';
}

/** Build the planning metadata payload embedded in the Work Item's metadata.planner. */
function buildPlannerMetadata(
  candidate: PlanningCandidate,
  baselineCommitSha: string | null,
  evaluatedAt: Date,
  plannerVersion: string,
): PlanningMetadataPayload {
  return {
    source: candidate.signal.kind,
    // PROVENANCE — passed through VERBATIM. The planner NEVER promotes the
    // signal's provenance; it records what the caller supplied (observed /
    // inferred / proposed). The literal 'confirmed' is NEVER assigned here —
    // confirmation is a separate authorized path on a baseline observation.
    provenance: candidate.signal.provenance,
    priority: candidate.priority,
    priorityFactors: candidate.priorityFactors,
    rationale: candidate.rationale,
    whyNow: candidate.whyNow,
    expectedImpact: candidate.expectedImpact,
    dedupKey: candidate.proposedWorkItemId,
    canonicalGoalHash: candidate.canonicalGoalHash,
    canonicalGoal: candidate.signal.canonicalGoal,
    baselineCommitSha,
    evaluatedAt: evaluatedAt.toISOString(),
    plannerVersion,
    // WORK-041: pass the maintenance metadata through VERBATIM (like
    // baselineCommitSha). The planner NEVER fabricates maintenance metadata —
    // it is supplied ONLY by trusted internal maintenance detectors. Absent
    // for non-maintenance signals (the field is optional).
    maintenance: candidate.signal.maintenance,
  };
}

export class DefaultDevelopmentPlannerService implements DevelopmentPlannerService {
  private readonly prioritizer: DevelopmentPlannerServiceDeps['prioritizer'];
  private readonly logger: DevelopmentPlannerServiceDeps['logger'];
  private readonly clock: () => Date;
  private readonly plannerVersion: string;

  constructor(deps: DevelopmentPlannerServiceDeps) {
    this.prioritizer = deps.prioritizer;
    this.logger = deps.logger;
    this.clock = deps.clock ?? (() => new Date());
    this.plannerVersion = 'work-040.v1';
  }

  async evaluate(
    input: PlanningEvaluateInput,
    ctx: PlanningContext,
  ): Promise<PlanningEvaluateResult> {
    // Tenant-safety: the route has already verified the architecture version
    // belongs to ctx.projectId. The orchestrator re-asserts it (defense in
    // depth — a UUID is NEVER an authorization credential).
    const version =
      await ctx.architectureVersionRepository.findById(
        input.architectureVersionId,
      );
    if (!version) {
      throw new Error('planning-architecture-version-not-found');
    }
    const arch = await ctx.architectureRepository.findById(version.architectureId);
    if (!arch || arch.projectId !== ctx.projectId) {
      throw new Error('planning-architecture-version-not-in-project');
    }

    // Load the existing Work Items in the target version ONCE (the dedup map).
    // This is the application-level pre-check; the DB UNIQUE constraint is the
    // hard fence against the race window between this load + the create.
    const existingItems =
      await ctx.workItemRepository.findByArchitectureVersion(
        input.architectureVersionId,
      );
    const existingByHumanId = new Map<string, WorkItem>();
    for (const wi of existingItems) {
      existingByHumanId.set(wi.workItemId, wi);
    }

    const evaluatedAt = this.clock();
    const baselineCommitSha = input.baselineCommitSha ?? null;
    const recommendations: PlanningRecommendation[] = [];
    let createdCount = 0;
    let alreadyExistsCount = 0;
    let failedCount = 0;

    for (const signal of input.signals) {
      // Prioritize → candidate.
      const candidate = await this.prioritizer.prioritize(signal, ctx);

      // Dedup pre-check: an equivalent Work Item (same proposedWorkItemId in
      // this version) already exists → converge (NO mutation of the existing
      // item — the planner re-evaluates honestly; it does NOT overwrite prior
      // planning evidence on an existing authoritative Work Item).
      const existing = existingByHumanId.get(candidate.proposedWorkItemId);
      if (existing) {
        recommendations.push({
          candidate,
          status: 'already-exists',
          workItemId: existing.id,
          workItemHumanId: existing.workItemId,
        });
        alreadyExistsCount++;
        continue;
      }

      // Create the authoritative Work Item THROUGH the existing
      // /work-items WorkItemRepository.create (the single creation path). The
      // planning evidence is embedded in metadata.planner (NOT a new column /
      // table). The planner NEVER sets `completed` (internal-only) + NEVER
      // creates a Work Order or workflow state (separate authorities).
      const metadataPayload = buildPlannerMetadata(
        candidate,
        baselineCommitSha,
        evaluatedAt,
        this.plannerVersion,
      );
      try {
        const created = await ctx.workItemRepository.create({
          architectureVersionId: input.architectureVersionId,
          workItemId: candidate.proposedWorkItemId,
          title: candidate.title,
          objective: candidate.objective,
          scope: candidate.scope ?? undefined,
          metadata: { planner: metadataPayload },
        });
        // Record in the dedup map so a later signal in the SAME evaluate run
        // with the same canonical goal converges (intra-run dedup).
        existingByHumanId.set(created.workItemId, created);
        recommendations.push({
          candidate,
          status: 'created',
          workItemId: created.id,
          workItemHumanId: created.workItemId,
        });
        createdCount++;
      } catch (err) {
        // A unique-violation means a CONCURRENT planner run created the same
        // (architecture_version_id, work_item_id) between our load + our
        // insert. Re-query → CONVERGE (no duplicate, no failure). This is the
        // hard concurrency fence — the DB constraint, NOT application
        // check-then-insert.
        if (isUniqueViolation(err)) {
          const reloaded =
            await ctx.workItemRepository.findByArchitectureVersion(
              input.architectureVersionId,
            );
          const converged = reloaded.find(
            (wi) => wi.workItemId === candidate.proposedWorkItemId,
          );
          if (converged) {
            existingByHumanId.set(converged.workItemId, converged);
            recommendations.push({
              candidate,
              status: 'already-exists',
              workItemId: converged.id,
              workItemHumanId: converged.workItemId,
            });
            alreadyExistsCount++;
            continue;
          }
          // The unique-violation fired but the row is not found on re-query —
          // a genuinely unexpected state. Record honestly as a failure (NO
          // false Work Item created — the insert threw, nothing landed).
          this.logger.error(
            'development-planner.unique-violation-without-convergence',
            {
              proposedWorkItemId: candidate.proposedWorkItemId,
              architectureVersionId: input.architectureVersionId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        // Any other error (FK violation, connection drop, etc.) → the create
        // FAILED. NO false Work Item was created — the insert threw, nothing
        // landed. Record honestly.
        this.logger.error('development-planner.create-failed', {
          proposedWorkItemId: candidate.proposedWorkItemId,
          architectureVersionId: input.architectureVersionId,
          error: err instanceof Error ? err.message : String(err),
        });
        recommendations.push({
          candidate,
          status: 'evaluation-failed',
          failureReason: err instanceof Error ? err.message : String(err),
        });
        failedCount++;
      }
    }

    return {
      recommendations,
      architectureVersionId: input.architectureVersionId,
      createdCount,
      alreadyExistsCount,
      failedCount,
    };
  }

  async listRecommendations(
    architectureVersionId: string,
    ctx: PlanningContext,
  ): Promise<readonly PlanningRecommendationSummary[]> {
    // READ-ONLY — never creates / mutates. List planner-originated Work Items
    // (those whose metadata.planner exists). The route has already verified the
    // version belongs to ctx.projectId; the orchestrator re-asserts it.
    const version =
      await ctx.architectureVersionRepository.findById(architectureVersionId);
    if (!version) {
      throw new Error('planning-architecture-version-not-found');
    }
    const arch = await ctx.architectureRepository.findById(version.architectureId);
    if (!arch || arch.projectId !== ctx.projectId) {
      throw new Error('planning-architecture-version-not-in-project');
    }
    const items =
      await ctx.workItemRepository.findByArchitectureVersion(architectureVersionId);
    const summaries: PlanningRecommendationSummary[] = [];
    for (const wi of items) {
      const planner = (wi.metadata as { planner?: PlanningMetadataPayload })
        ?.planner;
      if (!planner) continue; // a manually-created Work Item (no planner evidence)
      summaries.push({
        workItemId: wi.id,
        workItemHumanId: wi.workItemId,
        title: wi.title,
        objective: wi.objective,
        scope: wi.scope,
        completed: wi.completed,
        planner,
        createdAt: wi.createdAt,
        updatedAt: wi.updatedAt,
      });
    }
    return summaries;
  }
}

/**
 * Re-export the deterministic dedup helpers so the route / tests can compute
 * a proposedWorkItemId without re-implementing the hash (single source of
 * truth for the dedup key).
 */
export { computeProposedWorkItemId, computeCanonicalGoalHash };

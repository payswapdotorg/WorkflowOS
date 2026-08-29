/**
 * WORK-047 — the Agent Intelligence service (the application-layer
 * orchestrator).
 *
 * ADVISORY/RANKING ONLY (§33.9 + spec/work-orders/WORK-047.md). The service
 * composes EXISTING authorities and adds ONE new signal:
 *
 *   1. It consumes the WORK-044 routing result
 *      (AdaptiveExecutionRouterService.recommendExecution) — the routing
 *      authority's already-eligible ranked set, the excluded picture with
 *      the WORK-043 blocking reasons, the §22 decision id, the policy
 *      snapshot, the §15 task profile, and the benchmark evidence. It never
 *      reaches around the router to the policy service (the pipeline order
 *      is structural: eligibility → routing → intelligence).
 *   2. It collects the observed historical evidence from the EXISTING
 *      stores through the read-only repository (wfos_executions terminal
 *      outcomes + the W046-AC10 delegation structured state) — project-
 *      scoped, tenant-isolated by construction.
 *   3. It re-ranks the eligible set with the documented composite
 *      (0.6 routing + 0.4 observed execution history) and produces the
 *      recommendation with the FULL provenance model.
 *
 * The service is STATELESS (nothing persisted by this domain — the only
 * durable artifact is the §22 decision of the CONSUMED recommendation path,
 * anchored as decisionId), DETERMINISTIC (pure functions over the consumed
 * inputs + evidence), and READ-ONLY (no authoritative table is touched).
 */
import type { Logger } from '@platform/logger.js';

import type { AdaptiveExecutionRouterService, RoutingRecommendationResult } from '../../execution-routing/index.js';
import type { AgentIntelligenceRepository } from '../types.js';
import type {
  ConstraintsAppliedRecord,
  ConsumedRoutingSummary,
  EvidenceContribution,
  ExecutionHistoryCell,
  IntelligenceEvidenceSummary,
  IntelligenceExecutionRecommendation,
  IntelligenceDelegationRecommendation,
  IntelligenceProvenance,
  IntelligenceRankedCandidate,
  IntelligenceReason,
  IntelligenceRejectedAlternative,
  IntelligenceRoleCatalogLike,
  IntelligenceRequestInput,
  IntelligenceUnitRecommendation,
} from '../types.js';
import { AgentIntelligenceError } from '../types.js';
import {
  buildRejectedAlternatives,
  confidenceOf,
  executionContribution,
  findExecutionCell,
  rankWithIntelligence,
  HISTORY_WEIGHT,
  ROUTING_WEIGHT,
} from './intelligence-ranking.js';
import { computeDecomposition } from './decomposition.js';

export interface AgentIntelligenceServiceDeps {
  /** WORK-044 — the routing authority this layer consumes (never bypassed). */
  readonly router: AdaptiveExecutionRouterService;
  /** WORK-045 — the role catalog (roles resolved + pinned, never redefined). */
  readonly roleCatalog: IntelligenceRoleCatalogLike;
  /** The read-only historical-evidence repository (EXISTING stores only). */
  readonly repository: AgentIntelligenceRepository;
  readonly logger: Logger;
}

/** The suggested plan key for a recommended decomposition (WORK-046 vocabulary). */
export const RECOMMENDED_PLAN_KEY = 'intelligence-recommended';

export class DefaultAgentIntelligenceService {
  constructor(private readonly deps: AgentIntelligenceServiceDeps) {}

  async recommendExecution(input: IntelligenceRequestInput): Promise<IntelligenceExecutionRecommendation> {
    const { routing, evidence, ranked, rejected } = await this.collectAndRank(input);
    return this.buildExecutionRecommendation(input, routing, evidence, ranked, rejected);
  }

  async recommendDelegation(input: IntelligenceRequestInput): Promise<IntelligenceDelegationRecommendation> {
    const { routing, evidence, ranked, rejected } = await this.collectAndRank(input);
    const execution = this.buildExecutionRecommendation(input, routing, evidence, ranked, rejected);

    // The deterministic, task-profile-driven decomposition over the WORK-045
    // catalog (fail-closed on unknown roles; evidence annotates, never drops).
    const decomposition = computeDecomposition({
      taskProfile: evidence.taskProfile,
      roleCells: evidence.roleCells,
      resolveRole: (identity) => this.deps.roleCatalog.resolveRole(identity),
    });

    const assignment = execution.recommended;
    const warnings = [...execution.warnings, ...decomposition.warnings];
    const units: IntelligenceUnitRecommendation[] = decomposition.units.map((unit) => {
      if (!assignment) {
        // No eligible execution candidate: the role structure is still
        // recommended (roles are provider-independent) with the assignment
        // EXPLICITLY unavailable (never fabricated).
        return {
          ...unit,
          why: [
            ...unit.why,
            {
              dimension: 'unavailable',
              detail: 'no eligible execution candidate exists — the execution assignment is explicitly unavailable (the role recommendation stands; assign when eligibility opens)',
            },
          ],
        };
      }
      return {
        ...unit,
        mode: assignment.identity.executionMode,
        provider: assignment.identity.provider,
        model: assignment.identity.model,
        why: [
          ...unit.why,
          {
            dimension: 'routing_signal',
            detail: `execution assignment: the top of the intelligence ranking (${assignment.identity.provider}/${assignment.identity.model}/${assignment.identity.executionMode}, composite ${assignment.score.toFixed(3)} = ${ROUTING_WEIGHT}×routing(${assignment.components.routing.value.toFixed(3)}) + ${HISTORY_WEIGHT}×history(${assignment.components.historicalSuccess.value.toFixed(3)})) — every ranked candidate is already WORK-043-eligible`,
          },
        ],
      };
    });

    if (!assignment) {
      warnings.push(
        'no eligible execution candidate exists — the decomposition recommends the role structure only; the execution assignments are explicitly unavailable (submit the plan when eligibility opens, or assign manually)',
      );
    }

    return {
      mode: 'recommendation',
      projectId: input.projectId,
      workItemId: input.workItemId,
      planKey: RECOMMENDED_PLAN_KEY,
      units,
      rejectedRoles: decomposition.rejectedRoles,
      execution,
      evidence,
      warnings,
      submissionPath: `/projects/${input.projectId}/work-items/${input.workItemId}/delegation-plans`,
    };
  }

  // =========================================================================
  // internals
  // =========================================================================

  /** Consume the routing authority + collect the evidence + rank (shared by both operations). */
  private async collectAndRank(input: IntelligenceRequestInput): Promise<{
    routing: RoutingRecommendationResult;
    evidence: IntelligenceEvidenceSummary;
    ranked: readonly IntelligenceRankedCandidate[];
    rejected: readonly IntelligenceRejectedAlternative[];
  }> {
    // (1) CONSUME the routing authority (the pipeline order is structural:
    // the intelligence layer never reaches the policy service directly).
    const routing = await this.deps.router.recommendExecution({
      projectId: input.projectId,
      workItemId: input.workItemId,
      userId: input.userId,
      benchmarkMode: input.benchmarkMode,
    });
    if (!routing.taskProfile) {
      throw new AgentIntelligenceError(
        'agent-intelligence-routing-input-invalid',
        'the consumed routing result carries no task profile — the decomposition input is unusable (fail closed)',
      );
    }

    // (2) COLLECT the observed historical evidence (project-scoped, read-only).
    const [executionCells, roleCells] = await Promise.all([
      this.deps.repository.collectExecutionHistory(input.projectId),
      this.deps.repository.collectDelegationRoleHistory(input.projectId),
    ]);

    // (3) RANK (pure; the seam rejects ineligible candidates fail-closed).
    const { ranked } = rankWithIntelligence({ ranked: routing.ranked, executionCells });
    const rejected = buildRejectedAlternatives(routing.explanation.excluded);

    const evidence: IntelligenceEvidenceSummary = {
      scope: { projectId: input.projectId },
      executionCells,
      roleCells,
      benchmark: routing.benchmarkEvidence,
      taskProfile: routing.taskProfile,
    };
    return { routing, evidence, ranked, rejected };
  }

  private buildExecutionRecommendation(
    input: IntelligenceRequestInput,
    routing: RoutingRecommendationResult,
    evidence: IntelligenceEvidenceSummary,
    ranked: readonly IntelligenceRankedCandidate[],
    rejected: readonly IntelligenceRejectedAlternative[],
  ): IntelligenceExecutionRecommendation {
    const recommended = ranked[0] ?? null;
    const warnings: string[] = [];
    const totalObserved = evidence.executionCells.reduce((n, c) => n + c.attempts, 0);

    if (!recommended) {
      warnings.push(
        'no eligible execution candidate exists — the fail-closed answer: no recommendation (never a fallback to an ineligible candidate); see rejectedAlternatives for the authority\'s exclusion reasons',
      );
    } else {
      if (recommended.historicalSignal.successRate === null) {
        warnings.push(
          `no observed execution history for the recommended candidate (${recommended.identity.provider}/${recommended.identity.model}/${recommended.identity.executionMode}) — the historical component rests on the documented neutral prior (explicitly uncertain; never fabricated)`,
        );
      } else if (!recommended.historicalSignal.sufficient) {
        warnings.push(
          `thin observed execution history for the recommended candidate (${recommended.historicalSignal.sampleSize} attempt(s) — below the sufficiency threshold): the observed rate is used honestly and marked insufficient (§14: a single run is never definitive)`,
        );
      }
      if (totalObserved === 0) {
        warnings.push(
          'the project has no observed execution history at all — the recommendation rests on the routing signal alone (explicitly uncertain)',
        );
      }
    }

    const provenance = this.buildProvenance(routing, ranked, recommended, rejected, evidence.executionCells, totalObserved);

    return {
      mode: 'recommendation',
      projectId: input.projectId,
      workItemId: input.workItemId,
      recommended,
      ranked,
      fallbacks: ranked.slice(1),
      rejectedAlternatives: rejected,
      provenance,
      evidence: {
        scope: evidence.scope,
        executionCells: evidence.executionCells,
        roleCells: evidence.roleCells,
        benchmark: evidence.benchmark,
        taskProfile: evidence.taskProfile,
      },
      warnings,
    };
  }

  /** The full provenance model — the four questions, answered structurally. */
  private buildProvenance(
    routing: RoutingRecommendationResult,
    ranked: readonly IntelligenceRankedCandidate[],
    recommended: IntelligenceRankedCandidate | null,
    rejected: readonly IntelligenceRejectedAlternative[],
    executionCells: readonly ExecutionHistoryCell[],
    totalObserved: number,
  ): IntelligenceProvenance {
    const reasons: IntelligenceReason[] = [];
    let headline: string;

    if (!recommended) {
      headline =
        'no eligible execution candidate exists — no recommendation (the fail-closed answer; the excluded candidates and the authority\'s blocking reasons are listed in rejectedAlternatives)';
      reasons.push({
        dimension: 'hard_constraints',
        detail: `every candidate was excluded by the WORK-043 authority before this layer ran (${rejected.length} excluded; the routing decision ${routing.decisionId} carries the full picture)`,
      });
    } else {
      const r = recommended;
      headline =
        `recommended ${r.identity.provider}/${r.identity.model}/${r.identity.executionMode}: composite ${r.score.toFixed(3)} = ${ROUTING_WEIGHT}×routing(${r.components.routing.value.toFixed(3)}) + ${HISTORY_WEIGHT}×history(${r.components.historicalSuccess.value.toFixed(3)}, ${r.historicalSignal.sampleSize} observed attempt(s)); the routing authority ranked it #${r.routingRank}`;
      reasons.push({
        dimension: 'routing_signal',
        detail: `the consumed WORK-044 ranking placed this candidate #${r.routingRank} of ${routing.explanation.eligibleCount} eligible (routing score ${r.components.routing.value.toFixed(3)} — carried through, never recomputed; decision ${routing.decisionId})`,
      });
      if (r.historicalSignal.successRate !== null) {
        reasons.push({
          dimension: 'historical_success',
          detail: `observed execution history: ${r.historicalSignal.sampleSize} terminal attempt(s), success rate ${r.historicalSignal.successRate.toFixed(2)}${r.historicalSignal.lastObservedAt ? `, last observed ${r.historicalSignal.lastObservedAt.toISOString()}` : ''} (the observation window is surfaced — historical evidence, never presented as current)`,
        });
      } else {
        reasons.push({
          dimension: 'determinism',
          detail: 'no observed execution history for this candidate — the historical component is the documented neutral prior (0.5), explicitly marked insufficient',
        });
      }
      if (evidenceSays(routing)) {
        reasons.push({
          dimension: 'benchmark_evidence',
          detail: `the benchmark evidence carried through the routing result: sample size ${routing.benchmarkEvidence.sampleSize}${routing.benchmarkEvidence.observedQuality !== null ? `, observed quality ${routing.benchmarkEvidence.observedQuality}` : ''} (a ranking signal the routing authority already consumed)`,
        });
      }
    }

    // The constraints-already-applied record (carried from the authority).
    let constraintsApplied: ConstraintsAppliedRecord | null = null;
    if (recommended) {
      constraintsApplied = {
        decisionId: routing.decisionId,
        satisfiedConstraints: recommended.eligibility.satisfiedConstraints,
      };
      reasons.push({
        dimension: 'hard_constraints',
        detail: `constraints already applied by the WORK-043 authority before this layer ran: ${recommended.eligibility.satisfiedConstraints.length} satisfied (carried verbatim on the ranked row); the §22 decision ${routing.decisionId} is the durable audit anchor`,
      });
    }
    if (rejected.length > 0) {
      reasons.push({
        dimension: 'hard_constraints',
        detail: `${rejected.length} candidate(s) were excluded by the authorities and can never be recommended here — each carries the authority's own blocking reasons in rejectedAlternatives`,
      });
    }

    // The evidence contributions: every observed cell that backed the
    // ranking (the recommended + fallback candidates' cells).
    const contributingEvidence: EvidenceContribution[] = [];
    const seen = new Set<string>();
    for (const row of ranked) {
      const cell = findExecutionCell(executionCells, row.identity);
      if (cell && cell.attempts > 0) {
        const contribution = executionContribution(cell);
        if (!seen.has(contribution.cell)) {
          seen.add(contribution.cell);
          contributingEvidence.push(contribution);
        }
      }
    }

    const routingSummary: ConsumedRoutingSummary = {
      mode: 'recommendation',
      decisionId: routing.decisionId,
      routingRecommended: routing.recommended?.identity ?? null,
      eligibleCount: routing.explanation.eligibleCount,
      routingOrder: routing.ranked.map((c) => c.identity),
    };

    return {
      headline,
      reasons,
      contributingEvidence,
      constraintsApplied,
      rejectedAlternatives: rejected,
      routing: routingSummary,
      confidence: confidenceOf(recommended, totalObserved),
    };
  }
}

function evidenceSays(routing: RoutingRecommendationResult): boolean {
  return routing.benchmarkEvidence.sampleSize > 0;
}

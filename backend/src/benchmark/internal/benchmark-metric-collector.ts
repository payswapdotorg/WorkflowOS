/**
 * WORK-032: DefaultBenchmarkMetricCollector — reads AUTHORITATIVE state and
 * computes the metric row for a trial (§10).
 *
 * Authority model (§9): provider observations are NOT benchmark truth. The
 * collector reads ONLY from authoritative sources:
 *   - /workflows (workflowEngine.getState/getHistory) — workflow state + timestamps
 *   - /verification (verificationService.listRunsForWorkItem) — criteria pass/fail
 *   - /reviews (reviewService.listReviewsForWorkItem + listFindingsForReview) — verdicts + findings
 *   - /work-items (pullRequestAssociationRepository) — PR merge state
 *   - /github (ciEvidenceIngestionRepository.listForProject) — CI runs
 *   - /agents (agentRunRepository.findByWorkItem) — agent run count
 *
 * A provider claiming "all tests passed" does NOT count unless authoritative
 * CI confirms it. A provider claiming "PR complete" does NOT count unless
 * GitHub confirms the PR state.
 *
 * The collector NEVER mutates any domain state. It reads + computes + persists
 * the metric row (via the benchmark repository, which is a benchmark-scoped
 * table — not a domain table).
 *
 * Boundary: imports @modules/* public barrels only.
 */
import type { Logger } from '@platform/logger.js';
import type { BenchmarkTrial } from '../types.js';
import type {
  BenchmarkRepository,
  BenchmarkMetricCollector,
  BenchmarkTrialMetricsInsert,
  BenchmarkReviewFindingInsert,
} from './benchmark.types.js';
import type { WorkflowEngine } from '@modules/workflows/index.js';
import type { VerificationService } from '@modules/verification/index.js';
import type { ReviewService } from '@modules/reviews/index.js';
import type {
  PullRequestAssociationRepository,
} from '@modules/work-items/index.js';
import type {
  CiEvidenceIngestionRepository,
} from '@modules/github/index.js';
import type {
  AgentRunRepository,
} from '@modules/agents/index.js';
import {
  classifyCiFailureCategory,
  computeEngineeringQualityScore,
  BENCHMARK_SCORING_VERSION,
} from './benchmark-helpers.js';

const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

export interface DefaultBenchmarkMetricCollectorDeps {
  readonly repository: BenchmarkRepository;
  readonly workflowEngine: WorkflowEngine;
  readonly verificationService: VerificationService;
  readonly reviewService: ReviewService;
  readonly pullRequestAssociationRepository: PullRequestAssociationRepository;
  readonly ciEvidenceIngestionRepository: CiEvidenceIngestionRepository;
  readonly agentRunRepository: AgentRunRepository;
  readonly logger: Logger;
}

export class DefaultBenchmarkMetricCollector implements BenchmarkMetricCollector {
  constructor(private readonly deps: DefaultBenchmarkMetricCollectorDeps) {}

  async collect(trial: BenchmarkTrial): Promise<BenchmarkTrialMetricsInsert> {
    // A trial with no work_item_id has no authoritative state to read.
    if (!trial.workItemId) {
      return this.emptyMetrics(trial);
    }
    const workItemId = trial.workItemId;

    // --- Execution metrics (§10) ---
    // From the trial's own timestamps (server-set).
    const startedAt = trial.startedAt;
    const completedAt = trial.completedAt;
    const createdAt = trial.createdAt;
    const queueTimeMs = startedAt ? startedAt.getTime() - createdAt.getTime() : null;
    const executionDurationMs = startedAt && completedAt ? completedAt.getTime() - startedAt.getTime() : null;
    // startLatency: time from trial creation to execution start. For external
    // mode this includes the handoff→redeem window.
    const startLatencyMs = startedAt ? startedAt.getTime() - createdAt.getTime() : null;

    // --- Engineering metrics (§10) ---
    // From PullRequestAssociation (authoritative PR state).
    const prAssociations = await this.deps.pullRequestAssociationRepository.listForWorkItem(workItemId);
    const activePr = await this.deps.pullRequestAssociationRepository.findActiveForWorkItem(workItemId);
    const pullRequests = prAssociations.length;
    // filesChanged / linesAdded / linesDeleted: GitHub does not give us a clean
    // method on the adapter; these come from the raw webhook payload. For the
    // metric row we record what's authoritatively available (commit count from
    // push webhook events would require a query of wfos_github_webhook_events;
    // for the MVP we record the headCommit presence as a 1/0 commit proxy and
    // leave lines/files null unless a richer source is wired later).
    const commits = activePr?.headCommit ? 1 : 0;

    // --- CI metrics (§15) ---
    // From ciEvidenceIngestionRepository (authoritative GitHub Actions evidence).
    let ciRuns = 0;
    let ciFailures = 0;
    let ciFirstPass: boolean | null = null;
    let totalCiDurationMs = 0;
    const ciFailureCategories: Record<string, number> = {};
    let ciStartedAt: Date | null = null;
    let ciCompletedAt: Date | null = null;
    if (activePr?.headCommit) {
      const ciEvidence = await this.deps.ciEvidenceIngestionRepository.listForProject(trial.projectId, { headSha: activePr.headCommit });
      ciRuns = ciEvidence.length;
      // Order by runCompletedAt ASC for first-pass detection.
      const ordered = [...ciEvidence].sort((a, b) => {
        const at = a.runCompletedAt?.getTime() ?? 0;
        const bt = b.runCompletedAt?.getTime() ?? 0;
        return at - bt;
      });
      if (ordered.length > 0) {
        const first = ordered[0]!;
        ciFirstPass = first.conclusion === 'success';
      }
      for (const run of ciEvidence) {
        if (run.conclusion && FAILURE_CONCLUSIONS.has(run.conclusion)) {
          ciFailures++;
          const cat = classifyCiFailureCategory(run.workflowName, run.checkName);
          ciFailureCategories[cat] = (ciFailureCategories[cat] ?? 0) + 1;
        }
        if (run.runStartedAt && run.runCompletedAt) {
          totalCiDurationMs += run.runCompletedAt.getTime() - run.runStartedAt.getTime();
        }
        if (run.runStartedAt && (!ciStartedAt || run.runStartedAt < ciStartedAt)) ciStartedAt = run.runStartedAt;
        if (run.runCompletedAt && (!ciCompletedAt || run.runCompletedAt > ciCompletedAt)) ciCompletedAt = run.runCompletedAt;
      }
    }

    // --- Verification metrics (§14) ---
    // From verificationService.listRunsForWorkItem (authoritative).
    const verificationRuns = await this.deps.verificationService.listRunsForWorkItem(workItemId);
    const orderedRuns = [...verificationRuns].sort((a, b) => {
      const at = a.createdAt.getTime();
      const bt = b.createdAt.getTime();
      return at - bt;
    });
    let criteriaPassed: number | null = null;
    let criteriaFailed: number | null = null;
    let totalCriteria: number | null = null;
    let verificationFirstPass: boolean | null = null;
    let finalPass: boolean | null = null;
    let verificationStartedAt: Date | null = null;
    let verificationCompletedAt: Date | null = null;
    if (orderedRuns.length > 0) {
      const firstCompleted = orderedRuns.find((r) => r.status === 'completed');
      const last = orderedRuns[orderedRuns.length - 1]!;
      if (firstCompleted) {
        const s = firstCompleted.summary as { criteriaPass?: number; criteriaFail?: number; criteriaBlocked?: number; criteriaPending?: number };
        criteriaPassed = typeof s.criteriaPass === 'number' ? s.criteriaPass : null;
        criteriaFailed = typeof s.criteriaFail === 'number' ? s.criteriaFail : null;
        const blocked = typeof s.criteriaBlocked === 'number' ? s.criteriaBlocked : 0;
        const pending = typeof s.criteriaPending === 'number' ? s.criteriaPending : 0;
        totalCriteria = (criteriaPassed ?? 0) + (criteriaFailed ?? 0) + blocked + pending;
        verificationFirstPass = (criteriaPassed ?? 0) > 0 && (criteriaFailed ?? 0) === 0 && blocked === 0 && pending === 0;
        verificationStartedAt = firstCompleted.startedAt;
        verificationCompletedAt = firstCompleted.finishedAt;
      }
      const lastSummary = last.summary as { criteriaPass?: number; criteriaFail?: number; criteriaBlocked?: number; criteriaPending?: number };
      const lp = typeof lastSummary.criteriaPass === 'number' ? lastSummary.criteriaPass : 0;
      const lf = typeof lastSummary.criteriaFail === 'number' ? lastSummary.criteriaFail : 0;
      const lb = typeof lastSummary.criteriaBlocked === 'number' ? lastSummary.criteriaBlocked : 0;
      const lpe = typeof lastSummary.criteriaPending === 'number' ? lastSummary.criteriaPending : 0;
      finalPass = lp > 0 && lf === 0 && lb === 0 && lpe === 0;
    }

    // --- Review metrics (§13) ---
    // From reviewService.listReviewsForWorkItem (authoritative).
    const reviews = await this.deps.reviewService.listReviewsForWorkItem(workItemId);
    const finalizedReviews = reviews.filter((r) => r.outcome !== null);
    const requestChangesCount = finalizedReviews.filter((r) => r.outcome === 'REQUEST_CHANGES').length;
    const approvalCount = finalizedReviews.filter((r) => r.outcome === 'APPROVE').length;
    let reviewStartedAt: Date | null = null;
    let reviewCompletedAt: Date | null = null;
    const severityCounts: Record<string, number> = { blocker: 0, major: 0, minor: 0, info: 0 };
    let blockerFindings = 0;
    for (const review of reviews) {
      if (!reviewStartedAt || review.startedAt < reviewStartedAt) reviewStartedAt = review.startedAt;
      if (review.completedAt && (!reviewCompletedAt || review.completedAt > reviewCompletedAt)) reviewCompletedAt = review.completedAt;
      const findings = await this.deps.reviewService.listFindingsForReview(review.id);
      for (const f of findings) {
        severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;
        if (f.severity === 'blocker') blockerFindings++;
      }
    }

    // --- Correction cycles (§12) ---
    // From authoritative review state: each finalized review with
    // REQUEST_CHANGES prompts a new ImplementationContext revision + new
    // execution. correctionCycles = count of REQUEST_CHANGES reviews.
    const correctionCycles = requestChangesCount;
    // Agent runs: from agentRunRepository.findByWorkItem (authoritative).
    const agentRunsList = await this.deps.agentRunRepository.findByWorkItem(workItemId);
    const agentRuns = agentRunsList.length;

    // --- Time metrics (§16) ---
    // From workflowEngine.getHistory (authoritative transition timestamps).
    const history = await this.deps.workflowEngine.getHistory(workItemId);
    const firstTransitionTo = (state: string): Date | null => {
      const t = history.find((h) => h.toState === state);
      return t ? t.createdAt : null;
    };
    const prOpenAt = firstTransitionTo('pr_open');
    const approvedAt = firstTransitionTo('approved');
    const mergedAt = firstTransitionTo('merged');
    const verifiedAt = firstTransitionTo('verified');
    const baseTime = createdAt.getTime();
    const timeToPrMs = prOpenAt ? prOpenAt.getTime() - baseTime : null;
    const timeToApprovedMs = approvedAt ? approvedAt.getTime() - baseTime : null;
    const timeToMergedMs = mergedAt ? mergedAt.getTime() - baseTime : null;
    const timeToVerifiedMs = verifiedAt ? verifiedAt.getTime() - baseTime : null;

    // PR created timestamp (for §16): use the PR association's createdAt.
    const prCreatedAt = activePr?.createdAt ?? null;

    // --- Derived quality score (§11) ---
    const engineeringQualityScore = computeEngineeringQualityScore({
      verificationFirstPass,
      finalPass,
      ciFirstPass,
      correctionCycles,
      blockerFindings,
    });

    return {
      trialId: trial.id,
      queueTimeMs,
      startLatencyMs,
      executionDurationMs,
      filesChanged: null, // not authoritatively available without raw webhook parsing
      linesAdded: null,
      linesDeleted: null,
      commits,
      pullRequests,
      ciRuns,
      ciFailures,
      ciFirstPass,
      totalCiDurationMs: ciRuns > 0 ? totalCiDurationMs : null,
      ciFailureCategories: Object.keys(ciFailureCategories).length > 0 ? ciFailureCategories : null,
      verificationRuns: verificationRuns.length,
      criteriaPassed,
      criteriaFailed,
      verificationFirstPass,
      finalPass,
      totalCriteria,
      reviewCount: finalizedReviews.length,
      requestChangesCount,
      approvalCount,
      severityCounts: reviews.length > 0 ? severityCounts : null,
      correctionCycles,
      agentRuns,
      timeToPrMs,
      timeToApprovedMs,
      timeToMergedMs,
      timeToVerifiedMs,
      engineeringQualityScore,
      scoreVersion: BENCHMARK_SCORING_VERSION,
      executionStartedAt: startedAt,
      executionCompletedAt: completedAt,
      prCreatedAt,
      ciStartedAt,
      ciCompletedAt,
      verificationStartedAt,
      verificationCompletedAt,
      reviewStartedAt,
      reviewCompletedAt,
      mergedAt,
      verifiedAt,
    };
  }

  async collectFindings(trial: BenchmarkTrial): Promise<BenchmarkReviewFindingInsert[]> {
    if (!trial.workItemId) return [];
    const reviews = await this.deps.reviewService.listReviewsForWorkItem(trial.workItemId);
    const findings: BenchmarkReviewFindingInsert[] = [];
    for (const review of reviews) {
      const reviewFindings = await this.deps.reviewService.listFindingsForReview(review.id);
      for (const f of reviewFindings) {
        findings.push({
          trialId: trial.id,
          reviewId: review.id,
          severity: f.severity,
          category: f.affectedScope ?? null,
          file: f.evidenceRef ?? null,
          line: null,
          description: f.description,
        });
      }
    }
    return findings;
  }

  private emptyMetrics(trial: BenchmarkTrial): BenchmarkTrialMetricsInsert {
    return {
      trialId: trial.id,
      queueTimeMs: null,
      startLatencyMs: null,
      executionDurationMs: null,
      filesChanged: null,
      linesAdded: null,
      linesDeleted: null,
      commits: null,
      pullRequests: null,
      ciRuns: null,
      ciFailures: null,
      ciFirstPass: null,
      totalCiDurationMs: null,
      ciFailureCategories: null,
      verificationRuns: null,
      criteriaPassed: null,
      criteriaFailed: null,
      verificationFirstPass: null,
      finalPass: null,
      totalCriteria: null,
      reviewCount: null,
      requestChangesCount: null,
      approvalCount: null,
      severityCounts: null,
      correctionCycles: null,
      agentRuns: null,
      timeToPrMs: null,
      timeToApprovedMs: null,
      timeToMergedMs: null,
      timeToVerifiedMs: null,
      engineeringQualityScore: null,
      scoreVersion: null,
      executionStartedAt: trial.startedAt,
      executionCompletedAt: trial.completedAt,
      prCreatedAt: null,
      ciStartedAt: null,
      ciCompletedAt: null,
      verificationStartedAt: null,
      verificationCompletedAt: null,
      reviewStartedAt: null,
      reviewCompletedAt: null,
      mergedAt: null,
      verifiedAt: null,
    };
  }
}

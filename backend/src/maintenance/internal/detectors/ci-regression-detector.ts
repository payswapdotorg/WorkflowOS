/**
 * WORK-041: CiRegressionDetector — detects CI regressions from REAL webhook-fed
 * CI evidence (the `wfos_github_ci_evidence` table, populated by the /github
 * CiEvidenceIngestionService from check_run / workflow_run webhooks).
 *
 * Detection logic:
 *   1. listForProject(projectId) → all CI evidence for the project.
 *   2. Filter to completed runs (status === 'completed' — only completed runs
 *      have a conclusion).
 *   3. Group by workflowName (skip null workflowName).
 *   4. Sort each group by runStartedAt ascending.
 *   5. Find success→failure transitions: a run with conclusion === 'success'
 *      followed by a run with conclusion === 'failure' (or any non-success
 *      non-neutral conclusion) → a regression on that workflow.
 *   6. For each regression, produce a PlanningSignal (kind=maintenance-ci-regression,
 *      provenance=observed, evidence refs to both runs, maintenance metadata).
 *
 * HONEST SCOPE: this detector works ONLY off CI evidence that arrived via
 * webhook ingestion. If a project's CI ran but no webhook was delivered, no
 * evidence row exists + this detector produces no signal. On-demand check-run
 * fetching (a new GitHubAdapter.listCheckRunsForCommit method) is GREENFIELD +
 * declared future work. The detector does NOT fabricate CI runs.
 *
 * The detector NEVER calls GitHubAdapter methods (no on-demand fetch). It reads
 * the existing CiEvidenceIngestionRepository (read-only). The revision-bound
 * baselineCommitSha is the failing run's headSha (the commit the regression
 * appeared on).
 */

import type {
  MaintenanceContext,
  MaintenanceDetectInput,
} from '../../maintenance.types.js';
import type {
  PlanningSignal,
  MaintenanceSignalMetadata,
} from '@development-planner/index.js';
import type { MaintenanceDetector } from '../../maintenance.types.js';

/**
 * A CI regression detector. Reads CiEvidenceIngestionRepository.listForProject,
 * groups by workflowName, sorts by runStartedAt, finds success→failure
 * transitions, + produces maintenance-ci-regression PlanningSignals.
 */
export class CiRegressionDetector implements MaintenanceDetector {
  readonly name = 'ci-regression-detector';

  async detect(
    input: MaintenanceDetectInput,
    ctx: MaintenanceContext,
  ): Promise<readonly PlanningSignal[]> {
    const signals: PlanningSignal[] = [];
    const allRuns = await ctx.ciEvidenceRepository.listForProject(
      input.projectId,
    );
    if (allRuns.length === 0) return signals;

    // Filter to completed runs (only completed runs have a conclusion).
    const completed = allRuns.filter((r) => r.status === 'completed');
    if (completed.length === 0) return signals;

    // Group by workflowName (skip null workflowName).
    const byWorkflow = new Map<string, typeof completed>();
    for (const run of completed) {
      if (!run.workflowName) continue;
      const group = byWorkflow.get(run.workflowName) ?? [];
      group.push(run);
      byWorkflow.set(run.workflowName, group);
    }

    for (const [workflowName, runs] of byWorkflow) {
      // Sort by runStartedAt ascending (nulls last).
      const sorted = [...runs].sort((a, b) => {
        const aT = a.runStartedAt?.getTime() ?? 0;
        const bT = b.runStartedAt?.getTime() ?? 0;
        return aT - bT;
      });
      // Find success→failure transitions (a passing run followed by a failing run).
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!; // i >= 1 so i-1 >= 0; safe.
        const curr = sorted[i]!; // i < sorted.length; safe.
        const prevOk = prev.conclusion === 'success';
        const currFail =
          curr.conclusion === 'failure' ||
          (curr.conclusion !== null &&
            curr.conclusion !== 'success' &&
            curr.conclusion !== 'neutral');
        if (prevOk && currFail) {
          // A regression on this workflow. Produce a signal.
          const failingSha = curr.headSha ?? prev.headSha ?? undefined;
          const canonicalGoal = `Fix CI regression on workflow "${workflowName}" (started failing at ${failingSha ?? 'unknown sha'})`;
          const maintenance: MaintenanceSignalMetadata = {
            category: 'ci-regression',
            severity: 'high',
            detectorSource: this.name,
            affectedCount: 1,
          };
          signals.push({
            kind: 'maintenance-ci-regression',
            canonicalGoal,
            provenance: 'observed',
            evidenceRefs: [
              {
                kind: 'ci-evidence',
                ref: curr.id,
                detail: `failing run (conclusion: ${curr.conclusion}; headSha: ${curr.headSha ?? 'null'})`,
              },
              {
                kind: 'ci-evidence',
                ref: prev.id,
                detail: `last passing run (conclusion: ${prev.conclusion}; headSha: ${prev.headSha ?? 'null'})`,
              },
            ],
            baselineCommitSha: failingSha,
            maintenance,
          });
        }
      }
    }
    return signals;
  }
}

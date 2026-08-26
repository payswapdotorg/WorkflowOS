/**
 * WORK-038: DefaultOnboardingService — the application-layer orchestrator.
 *
 * Composes the EXISTING domain authorities to produce an evidence-backed
 * Project Baseline:
 *
 *   /github  → resolve the repo link (ProjectGitHubRepositoryRepository) +
 *              resolve the EXACT revision (GitHubAdapter.getBranch → the
 *              precise commit SHA; the SHA — not the ref — is the baseline
 *              identity).
 *   analyzer → governed analysis (the GovernedFilesystemAnalyzer routes
 *              every read through the project-scoped ToolPolicyGate; records
 *              the decision as evidence; redacts secrets; produces
 *              observed/inferred/proposed observations). NEVER confirmed.
 *   /projects → store the baseline + observations + evidence
 *              (ProjectBaselineRepository). /projects remains the single
 *              project authority; this orchestrator owns NO tables.
 *
 * CRASH / CONCURRENCY SAFETY:
 *   * ensureBaseline is idempotent (UNIQUE(project, repo, commit) — a
 *     re-onboard of the same revision returns the SAME row; no second
 *     baseline).
 *   * observations are upserted idempotently (claim-digest unique) — a
 *     re-drive after a mid-analysis crash appends no duplicates.
 *   * markComplete is a CAS (version predicate) — concurrent onboarding
 *     requests converge (the CAS loser observes the winner's row).
 *   * the exact revision is resolved ONCE per baseline (immutable identity);
 *     a moving branch does not mutate an in-flight baseline.
 *
 * The orchestrator NEVER mutates workflow / verification / review /
 * architecture-frozen state, NEVER stores credentials, NEVER imports provider
 * SDKs. Provenance is never silently promoted (the analyzer cannot produce
 * 'confirmed'; only the authorized confirmObservation path can).
 */
import type { Logger } from '@platform/logger.js';
import type { GitHubAdapter } from '@modules/github/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  ProjectBaselineRepository,
  EnsureBaselineInput,
} from '@modules/projects/index.js';
import type { ProjectGitHubRepositoryRepository } from '@modules/github/index.js';
import type {
  OnboardRepositoryInput,
  OnboardResult,
  OnboardingService,
  RepositoryAnalyzer,
  AnalysisContext,
  GovernedRepositoryReadPolicy,
} from '../onboarding.types.js';
// PR #42 round-2 (Blocker B): the typed onboarding-analysis error. Thrown
// by the analyzer when a content read hits an infrastructure failure
// (GitHub unavailable / authentication failure / API failure / content
// retrieval infrastructure failure). Caught here to markFailed the baseline
// with failure_stage='repository-content-unavailable' (forensic provenance)
// — a baseline must NEVER reach 'complete' when the required repository
// analysis could not actually inspect the repository.
import { OnboardingAnalysisError } from '../onboarding.types.js';

export interface DefaultOnboardingServiceDeps {
  readonly projectRepository: ProjectRepository;
  readonly projectBaselineRepository: ProjectBaselineRepository;
  readonly projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository;
  readonly githubAdapter: GitHubAdapter;
  readonly analyzer: RepositoryAnalyzer;
  /**
   * PR #42 round-5 (the persistence-boundary fence): the governed repository-
   * read boundary. The orchestrator calls capturePersistenceSnapshot() AFTER
   * analyze() returns + BEFORE the persistence transaction begins. The
   * returned snapshot is the persistence-boundary fence's reference value —
   * the repository's persistBaselineWithPolicyFence method revalidates it
   * INSIDE the DB transaction (pre-writes + post-writes + per-read
   * verification) + rolls back if it is stale.
   */
  readonly governedReadPolicy: GovernedRepositoryReadPolicy;
  readonly logger: Logger;
}

export class DefaultOnboardingService implements OnboardingService {
  constructor(private readonly deps: DefaultOnboardingServiceDeps) {}

  async onboard(input: OnboardRepositoryInput): Promise<OnboardResult> {
    // 1. Resolve the project → organization (tenant scope). Fail closed if
    //    the project does not exist (no onboarding of an unknown project).
    const project = await this.deps.projectRepository.findById(input.projectId);
    if (!project) {
      throw new Error(`onboarding.project-not-found: project ${input.projectId} does not exist`);
    }

    // 2. Resolve the project's /github repository link (the EXISTING
    //    authority — never a duplicate repo table). Fail closed if none.
    const repoLink =
      await this.deps.projectGitHubRepositoryRepository.findByProject(input.projectId);
    if (!repoLink) {
      throw new Error(
        `onboarding.no-repository-link: project ${input.projectId} has no linked GitHub repository — connect a repository first through /github`,
      );
    }

    // 3. Resolve the EXACT revision: the ref's HEAD COMMIT SHA through the
    //    EXISTING /github GitHubAdapter.getBranch. The SHA (not the ref) is
    //    the baseline identity — reproducibility from a REAL Git revision.
    //    NEVER a prompt hash, timestamp, branch name alone, or generated ID.
    const ref = input.ref ?? repoLink.defaultBranch;
    let baselineCommitSha: string;
    try {
      const branch = await this.deps.githubAdapter.getBranch({
        owner: repoLink.owner,
        repository: repoLink.repository,
        branchName: ref,
        installationId: repoLink.installationId,
      });
      baselineCommitSha = branch.sha;
    } catch (err) {
      throw new Error(
        `onboarding.revision-unresolvable: could not resolve the HEAD commit SHA for ref '${ref}' on ${repoLink.owner}/${repoLink.repository} through /github — ${(err as Error).message}`,
      );
    }
    if (!baselineCommitSha) {
      throw new Error(
        `onboarding.revision-unresolvable: /github getBranch returned an empty SHA for ref '${ref}' — fail closed (no placeholder revision)`,
      );
    }

    // 4. Deterministic analysis-run identity (links evidence rows to this
    //    baseline reconstruction; stable across retries → idempotent evidence).
    const analysisMode = input.analysisMode ?? 'native';
    const analysisRunId = `onboarding:${input.projectId}:${repoLink.id}:${baselineCommitSha}`;

    // 5. Idempotent ensureBaseline (one row per project+repo+exact commit).
    const ensureInput: EnsureBaselineInput = {
      projectId: input.projectId,
      organizationId: project.organizationId,
      projectGithubRepositoryId: repoLink.id,
      repositoryOwner: repoLink.owner,
      repositoryName: repoLink.repository,
      baselineCommitSha,
      revisionRef: ref,
      analysisMode,
      analysisRunId,
    };
    const baseline = await this.deps.projectBaselineRepository.ensureBaseline(ensureInput);

    // 6. Idempotent re-entry: an already-complete baseline is returned as-is
    //    (no re-analysis — the same revision produces the same baseline).
    //    A failed baseline is terminal; the caller observes + decides (a
    //    re-onboard of the same revision keeps it failed; a new revision
    //    creates a new baseline). An 'analyzing' baseline (interrupted) is
    //    re-driven by this call (crash recovery).
    if (baseline.state === 'complete') {
      return {
        baseline: toBaselineHeader(baseline),
        analyzed: false,
      };
    }
    if (baseline.state === 'failed') {
      return {
        baseline: toBaselineHeader(baseline),
        analyzed: false,
      };
    }

    // 7. Run the governed analyzer (the WORK-037 policy gate is consulted
    //    for every read; the decision is recorded as evidence).
    const analysisContext: AnalysisContext = {
      baselineId: baseline.id,
      projectId: input.projectId,
      organizationId: project.organizationId,
      repositoryOwner: repoLink.owner,
      repositoryName: repoLink.repository,
      installationId: repoLink.installationId,
      baselineCommitSha,
      revisionRef: ref,
      analysisRunId,
      analysisMode,
    };

    try {
      const result = await this.deps.analyzer.analyze(analysisContext);

      // 8. PR #42 round-7 (the scope-resolution fence): capture the CURRENT
      //    policy snapshot AFTER analyze() returns (every evidence row has
      //    its per-read snapshot from the round-4 fence) AND BEFORE the
      //    persistence transaction begins. The snapshot (including `source`
      //    — which effective scope the gate surfaced: project-override / org
      //    default / platform-default) is the fence's reference value.
      //
      //    THE ARCHITECT'S ROUND-7 BLOCKER (review of commit `60dda58`):
      //    the round-6 fence locked ONLY the row represented by
      //    `snapshot.source`. That works when the current effective policy
      //    source is an existing project/org policy row. But consider: when
      //    the current effective source is `organization` (no project policy
      //    exists) and a concurrent T2 CREATES a NEW project policy row, the
      //    effective policy changes (project now overrides organization) but
      //    the locked organization row did NOT change → the round-6 fence
      //    let V7 (org) stale evidence commit under the new V1 (project)
      //    effective policy. The inverse hole existed when a project policy
      //    was DELETED and resolution fell back to organization. The
      //    architect's invariant: "policy row immutability ≠ effective
      //    policy immutability."
      //
      //    THE ROUND-7 FIX: the repository's persistBaselineWithPolicyFence
      //    method locks the scope ANCHORS (wfos_projects + wfos_organizations)
      //    AND the relevant policy rows (project + org, present OR absent)
      //    INSIDE the same PostgreSQL transaction, then RE-RESOLVES the
      //    effective policy from the locked rows + compares (source, version)
      //    against the snapshot. The mutation paths (setProjectPolicy /
      //    clearProjectPolicy / setOrganizationPolicy /
      //    clearOrganizationPolicy) acquire the SAME anchor lock — so the
      //    two transactions SERIALIZE even when the effective policy changes
      //    because a row is CREATED or DELETED.
      const persistenceSnapshot =
        await this.deps.governedReadPolicy.capturePersistenceSnapshot(analysisContext);

      // 9. Persist evidence + observations + complete the baseline in ONE
      //    PostgreSQL transaction, under the captured persistence-boundary
      //    snapshot + the scope-resolution fence. PR #42 round-2 (Blocker A):
      //    observations reference evidence by LOCATOR (the path), not by a
      //    manufactured toolInvocationId. The repository's
      //    persistBaselineWithPolicyFence resolves locator→evidence id by the
      //    composite (source, locator) key inside the transaction. PR #42
      //    round-7: the fence locks the scope ANCHOR rows (wfos_projects +
      //    wfos_organizations) AND the relevant policy rows INSIDE the
      //    transaction (FOR UPDATE), RE-RESOLVES the effective policy from
      //    the locked rows, and compares (source, version) against the
      //    snapshot. If the effective source DIFFERS (a row was CREATED or
      //    DELETED mid-flight) OR the version DIFFERS → ROLLBACK → zero
      //    stale evidence/observations are committed.
      const persistResult =
        await this.deps.projectBaselineRepository.persistBaselineWithPolicyFence({
          baselineId: baseline.id,
          evidence: result.evidence,
          observations: result.observations,
          contentDigest: result.contentDigest,
          expectedVersion: baseline.version,
          snapshot: persistenceSnapshot,
          // PR #42 round-7 (the scope-resolution fence): the fence locks
          // the scope ANCHOR rows (wfos_projects + wfos_organizations) +
          // the relevant policy rows for this (organization, project) via
          // SELECT ... FOR UPDATE INSIDE the same PostgreSQL transaction
          // that holds the baseline persistence writes. The locks are
          // held from the re-resolution THROUGH commit, so a concurrent
          // policy mutation (setProjectPolicy / setOrganizationPolicy /
          // clearProjectPolicy / clearOrganizationPolicy — all acquire
          // the SAME anchor lock) must either WAIT for this transaction
          // to commit OR commit first (then the fence's locked re-
          // resolution sees the NEW effective policy → source/version
          // mismatch → ROLLBACK → zero stale evidence/observations are
          // committed). The architect's round-7 invariant — assert
          // against the EFFECTIVE policy version/source, NOT merely the
          // old policy row's version — is honored.
          organizationId: analysisContext.organizationId,
          projectId: analysisContext.projectId,
        });

      // 10. Handle the persist result. Three success paths + two fence-
      //     rejection paths.
      if (persistResult.kind === 'persisted') {
        return { baseline: toBaselineHeader(persistResult.baseline), analyzed: true };
      }
      if (persistResult.kind === 'cas-lost') {
        // CAS lost — another concurrent onboarding completed it. Re-read
        // the winner's row (convergence).
        const winner = await this.deps.projectBaselineRepository.findById(baseline.id);
        return {
          baseline: toBaselineHeader(winner ?? baseline),
          analyzed: false,
        };
      }
      // 11. The fence REJECTED the persist (fence-stale OR fence-
      //     revalidation-failed). ZERO evidence/observations are committed
      //     (the transaction was rolled back). The baseline is still
      //     'analyzing' (the markComplete was rolled back too). Mark it
      //     failed so the staleness is OBSERVABLE in the durable record
      //     (forensic provenance) + the baseline doesn't get stuck in
      //     'analyzing' (it's terminal). The orchestrator logs the fence
      //     rejection + the snapshot/revalidation metadata.
      const fenceFailureStage =
        persistResult.kind === 'fence-stale'
          ? 'policy-snapshot-stale-at-persistence'
          : 'policy-snapshot-revalidation-failed';
      this.deps.logger.warn('onboarding.persistence-fence-rejected', {
        baselineId: baseline.id,
        failureStage: fenceFailureStage,
        snapshot: persistResult.snapshot,
        revalidated:
          persistResult.kind === 'fence-stale' ? persistResult.revalidated : null,
        reason: persistResult.reason,
      });
      try {
        const failed = await this.deps.projectBaselineRepository.markFailed(
          baseline.id,
          fenceFailureStage,
          baseline.version,
        );
        if (failed) {
          return { baseline: toBaselineHeader(failed), analyzed: true };
        }
        // CAS lost on markFailed (rare — another worker completed/failed
        // it concurrently). Re-read the winner's row (convergence).
        const winner = await this.deps.projectBaselineRepository.findById(baseline.id);
        return {
          baseline: toBaselineHeader(winner ?? baseline),
          analyzed: false,
        };
      } catch {
        // markFailed itself failed (e.g. a confirmed observation exists —
        // invariant violation, OR the baseline is no longer 'analyzing').
        // Re-throw a synthetic error so the caller's outer catch sees the
        // fence-rejection root cause; the baseline stays in its current
        // state for a retry.
        throw new Error(
          `onboarding.persistence-fence-rejected-and-markfailed-failed: baseline ${baseline.id} had its persistence rejected by the fence (${fenceFailureStage}) but markFailed itself failed — the baseline is in an unexpected state; reason: ${persistResult.reason}`,
        );
      }
    } catch (err) {
      // 11. markFailed on any analysis error (failed analysis cannot produce
      //     a false confirmed baseline — the repository enforces no confirmed
      //     observation may exist on a failed baseline). The failure_stage
      //     records where the analysis failed.
      //     PR #42 round-2 (Blocker B): an OnboardingAnalysisError with code
      //     'repository-content-unavailable' is the typed signal that a
      //     content read hit an infrastructure failure (GitHub unavailable,
      //     authentication failure, API failure, content retrieval
      //     infrastructure failure). The failure_stage is set to
      //     'repository-content-unavailable' (forensic provenance — the
      //     baseline did NOT reach 'complete' on a content-provider
      //     failure; the required repository analysis could not actually
      //     inspect the repository). Other errors keep the generic
      //     'analysis-error' failure stage.
      const isContentUnavailable =
        err instanceof OnboardingAnalysisError &&
        err.code === 'repository-content-unavailable';
      const failureStage = isContentUnavailable
        ? 'repository-content-unavailable'
        : 'analysis-error';
      this.deps.logger.warn('onboarding.analysis-failed', {
        baselineId: baseline.id,
        failureStage,
        error: (err as Error).message,
        failingLocator: err instanceof OnboardingAnalysisError ? err.failingLocator : null,
      });
      try {
        const failed = await this.deps.projectBaselineRepository.markFailed(
          baseline.id,
          failureStage,
          baseline.version,
        );
        if (failed) {
          return { baseline: toBaselineHeader(failed), analyzed: true };
        }
        // CAS lost — re-read (convergence).
        const winner = await this.deps.projectBaselineRepository.findById(baseline.id);
        return {
          baseline: toBaselineHeader(winner ?? baseline),
          analyzed: false,
        };
      } catch {
        // markFailed itself failed (e.g. a confirmed observation exists —
        // invariant violation). Re-throw the original analysis error so the
        // caller sees the root cause; the baseline stays 'analyzing' for a
        // retry.
        throw err;
      }
    }
  }
}

function toBaselineHeader(b: {
  id: string;
  state: string;
  version: number;
  baselineCommitSha: string;
  revisionRef: string;
  analysisMode: string;
  analysisRunId: string | null;
  contentDigest: string | null;
  failureStage: string | null;
  finalizedAt: Date | null;
}): OnboardResult['baseline'] {
  return {
    id: b.id,
    state: b.state,
    version: b.version,
    baselineCommitSha: b.baselineCommitSha,
    revisionRef: b.revisionRef,
    analysisMode: b.analysisMode as OnboardResult['baseline']['analysisMode'],
    analysisRunId: b.analysisRunId,
    contentDigest: b.contentDigest,
    // PR #42 round-2 (Blocker B): surface the failure_stage so the caller
    // sees WHERE analysis failed (e.g. 'repository-content-unavailable'
    // when a content read hit an infrastructure failure).
    failureStage: b.failureStage,
    finalizedAt: b.finalizedAt,
  };
}

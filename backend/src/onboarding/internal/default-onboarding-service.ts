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
  NewBaselineObservation,
} from '@modules/projects/index.js';
import type { ProjectGitHubRepositoryRepository } from '@modules/github/index.js';
import type {
  OnboardRepositoryInput,
  OnboardResult,
  OnboardingService,
  RepositoryAnalyzer,
  AnalysisContext,
} from '../onboarding.types.js';

export interface DefaultOnboardingServiceDeps {
  readonly projectRepository: ProjectRepository;
  readonly projectBaselineRepository: ProjectBaselineRepository;
  readonly projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository;
  readonly githubAdapter: GitHubAdapter;
  readonly analyzer: RepositoryAnalyzer;
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

      // 8. Persist evidence, then link observations to evidence ids.
      const persistedEvidence =
        await this.deps.projectBaselineRepository.appendEvidence(baseline.id, result.evidence);
      const evidenceByInvocation = new Map<string, string>();
      for (const ev of persistedEvidence) {
        if (ev.toolInvocationId) evidenceByInvocation.set(ev.toolInvocationId, ev.id);
      }
      const linkedObservations: NewBaselineObservation[] = result.observations.map((obs) => ({
        ...obs,
        evidenceRef: obs.evidenceRef
          .map((ref) => evidenceByInvocation.get(ref) ?? null)
          .filter((v): v is string => v !== null),
      }));

      // 9. Idempotent upsert (claim-digest unique — a re-drive appends no
      //    duplicates). Observations may only be appended while 'analyzing'.
      await this.deps.projectBaselineRepository.upsertObservations(baseline.id, linkedObservations);

      // 10. CAS complete (version predicate — concurrent requests converge;
      //     the loser observes the winner's row via the null return).
      const completed = await this.deps.projectBaselineRepository.markComplete(
        baseline.id,
        result.contentDigest,
        baseline.version,
      );
      if (completed) {
        return { baseline: toBaselineHeader(completed), analyzed: true };
      }
      // CAS lost — another concurrent onboarding completed it. Re-read the
      // winner's row (convergence).
      const winner = await this.deps.projectBaselineRepository.findById(baseline.id);
      return {
        baseline: toBaselineHeader(winner ?? baseline),
        analyzed: false,
      };
    } catch (err) {
      // 11. markFailed on any analysis error (failed analysis cannot produce
      //     a false confirmed baseline — the repository enforces no confirmed
      //     observation may exist on a failed baseline). The failure_stage
      //     records where the analysis failed.
      this.deps.logger.warn('onboarding.analysis-failed', {
        baselineId: baseline.id,
        error: (err as Error).message,
      });
      try {
        const failed = await this.deps.projectBaselineRepository.markFailed(
          baseline.id,
          'analysis-error',
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
    finalizedAt: b.finalizedAt,
  };
}

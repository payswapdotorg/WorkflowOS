/**
 * WORK-038: Project Baseline domain types — the evidence-backed reconstruction
 * of a software repository WorkflowOS did NOT originally create.
 *
 * The baseline is a PROJECT artifact (PROJ-001 scope), stored THROUGH the
 * existing /projects authority. It is NOT a second project/repo/architecture/
 * requirements/workflow/verification/review authority:
 *
 *   * repository identity → the EXISTING /github ProjectGitHubRepository row
 *     (the baseline references it by FK; never a duplicate repo table)
 *   * exact revision → a real Git commit SHA resolved through the EXISTING
 *     /github GitHubAdapter.getBranch (never a prompt hash, timestamp, branch
 *     name alone, or generated ID)
 *   * proposed architecture → a PROPOSED observation (never an auto-created
 *     FROZEN ArchitectureVersion; /architecture remains the architecture
 *     authority)
 *   * inferred requirements → observations (never authoritative requirements;
 *     /requirements remains the requirements authority)
 *
 * PROVENANCE MODEL (architecture-lock.md "Existing-project truth model"):
 *   observed   — directly established from repository/GitHub/CI/runtime evidence
 *   inferred    — reasoned from observations, not explicitly established
 *   confirmed  — explicitly validated through the authorized confirmation path
 *   proposed    — a suggested future state, not a statement of current fact
 *
 * These are NEVER collapsed into a single confidence number. Inferred facts
 * are NEVER stored as authoritative. Provenance is NEVER silently promoted
 * (inferred/proposed → confirmed requires the authorized confirmation path;
 * proposed → observed is forbidden). Enforcement is layered: the service
 * methods + the DB CHECK constraints + the observation-guard trigger
 * (migration 0038).
 *
 * This file is private to /projects (PLAT-AC-02). The public types are
 * re-exported through the /projects barrel.
 */

// --- Provenance (the central invariant) ---

/**
 * The provenance of a reconstructed fact. NEVER collapsed into a confidence
 * number. See file header for the interpretation of each value.
 */
export type BaselineProvenance = 'observed' | 'inferred' | 'confirmed' | 'proposed';

/** The baseline header state machine. */
export type BaselineState = 'analyzing' | 'complete' | 'failed';

/** Whether analysis ran natively (governed host tooling) or was reported externally. */
export type BaselineAnalysisMode = 'native' | 'external';

/**
 * The observation kind (the baseline-content categories from the frozen
 * WORK-038 contract). The DB CHECK constraint is the authority; this union
 * mirrors it for type-safety.
 */
export type BaselineObservationKind =
  | 'repository_identity'
  | 'stack'
  | 'languages'
  | 'frameworks'
  | 'package_managers'
  | 'build_commands'
  | 'test_commands'
  | 'lint_commands'
  | 'architecture'
  | 'documentation'
  | 'requirements'
  | 'dependencies'
  | 'security'
  | 'ci'
  | 'deployment'
  | 'runtime'
  | 'historical';

/** The evidence source class (where the observation was established from). */
export type BaselineEvidenceSource =
  | 'filesystem'
  | 'github_ci'
  | 'runtime'
  | 'config'
  | 'metadata'
  | 'provider_report';

// --- Records ---

/** The Project Baseline header (one per project + repo + exact commit). */
export interface ProjectBaseline {
  readonly id: string;
  readonly projectId: string;
  readonly organizationId: string;
  /** The EXISTING /github authority row this baseline reconstructs. */
  readonly projectGithubRepositoryId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  /** The IMMUTABLE exact repository revision (a real Git commit SHA). */
  readonly baselineCommitSha: string;
  /** The human-readable ref that resolved to the SHA (display-only). */
  readonly revisionRef: string;
  readonly state: BaselineState;
  readonly version: number;
  readonly analysisMode: BaselineAnalysisMode;
  /** sha256 of the canonical observation set (set on complete; null otherwise). */
  readonly contentDigest: string | null;
  readonly failureStage: string | null;
  /** The governed-analysis run identity (links to evidence rows). */
  readonly analysisRunId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finalizedAt: Date | null;
  readonly terminalAt: Date | null;
}

/** A provenance-tagged reconstructed claim. */
export interface BaselineObservation {
  readonly id: string;
  readonly baselineId: string;
  readonly kind: BaselineObservationKind;
  readonly provenance: BaselineProvenance;
  /** The structured claim (redacted of secrets). */
  readonly claim: Record<string, unknown>;
  /** sha256 of the canonical claim — the idempotency key. */
  readonly claimDigest: string;
  /** References to wfos_project_baseline_evidence rows (UUIDs). */
  readonly evidenceRef: readonly string[];
  readonly confirmedBy: string | null;
  readonly confirmedAt: Date | null;
  readonly createdAt: Date;
}

/** An evidence row backing one or more observations. */
export interface BaselineEvidence {
  readonly id: string;
  readonly baselineId: string;
  readonly source: BaselineEvidenceSource;
  readonly locator: string;
  readonly contentDigest: string | null;
  readonly redacted: boolean;
  /**
   * The governed ToolRuntime invocation identity (the WORK-036 boundary).
   * NON-NULL ONLY when the read was performed through ToolRuntime.invoke.
   * NULL when the read was performed through the /github authority (the
   * onboarding content-read path — the analyzer consults the WORK-037
   * project-scoped policy gate, then delegates to the /github
   * GitHubAdapter; that is NOT a ToolRuntime invocation). Also NULL for
   * external-reported evidence. The PR #42 round-2 review forbade
   * manufacturing tool_invocation_ids for operations that never went
   * through Tool Runtime.
   */
  readonly toolInvocationId: string | null;
  /**
   * The WORK-037 policy decision that governed this read — the audit trail.
   * NON-NULL ONLY when a host tool run occurred (a ToolRuntime invocation
   * gated by the WORK-037 engine's decide()). NULL when no host tool run
   * occurred (the /github-authority read path; external-reported
   * evidence). The WORK-037 project-scoped gate IS still consulted at
   * runtime (the analyzer refuses to proceed on deny/ask); that
   * consultation is a runtime invariant, not an evidence-row claim.
   */
  readonly policyDecision: 'allow' | 'constrained' | 'deny' | 'ask' | null;
  readonly observedAt: Date;
  readonly createdAt: Date;
}

// --- Inputs (produced by the onboarding orchestrator / analyzer) ---

/** A new observation to append (idempotent on (baseline, kind, claim_digest)). */
export interface NewBaselineObservation {
  readonly kind: BaselineObservationKind;
  readonly provenance: BaselineProvenance;
  readonly claim: Record<string, unknown>;
  /** Pre-computed sha256 of the canonical claim. */
  readonly claimDigest: string;
  /** Evidence row IDs backing this observation. */
  readonly evidenceRef: readonly string[];
}

/** A new evidence row to persist. */
export interface NewBaselineEvidence {
  readonly source: BaselineEvidenceSource;
  readonly locator: string;
  readonly contentDigest: string | null;
  readonly redacted: boolean;
  readonly toolInvocationId: string | null;
  readonly policyDecision: 'allow' | 'constrained' | 'deny' | 'ask' | null;
}

/** Input for the idempotent ensureBaseline (one row per project+repo+commit). */
export interface EnsureBaselineInput {
  readonly projectId: string;
  readonly organizationId: string;
  readonly projectGithubRepositoryId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly baselineCommitSha: string;
  readonly revisionRef: string;
  readonly analysisMode: BaselineAnalysisMode;
  readonly analysisRunId?: string;
}

// --- Repository ---

/**
 * Persistence + domain-operation interface for Project Baselines (table:
 * `wfos_project_baselines` + `wfos_project_baseline_observations` +
 * `wfos_project_baseline_evidence`, migration 0038).
 *
 * The interface is the authority for baseline storage. The src/onboarding/
 * application capability composes it; the confirmation route calls
 * confirmObservation directly (the authorized promotion path).
 */
export interface ProjectBaselineRepository {
  /**
   * Idempotent ensure: one baseline per (project, repo, exact commit). A
   * re-analyze of the same revision returns the SAME row — never a second
   * baseline. Crash-safe: a row created then interrupted sits in 'analyzing'
   * and is re-driven by a retry.
   */
  ensureBaseline(input: EnsureBaselineInput): Promise<ProjectBaseline>;

  findById(id: string): Promise<ProjectBaseline | null>;
  /** Find the baseline for a project + repo + exact commit (the idempotency key). */
  findByRevision(
    projectId: string,
    projectGithubRepositoryId: string,
    baselineCommitSha: string,
  ): Promise<ProjectBaseline | null>;
  listForProject(projectId: string): Promise<ProjectBaseline[]>;

  /**
   * Persist evidence rows for a baseline. Idempotent on (baseline_id, source,
   * locator) — a re-drive of the same governed read does not duplicate
   * evidence. Returns the persisted rows (with their IDs, for observation
   * evidence_ref linkage). The PR #42 round-2 review replaced the prior
   * (baseline_id, tool_invocation_id) key: tool_invocation_id is NULL for
   * /github-authority reads (no ToolRuntime invocation), so the prior key
   * could not deduplicate (NULL != NULL in PostgreSQL UNIQUE). The honest
   * composite key is (source, locator).
   */
  appendEvidence(
    baselineId: string,
    evidence: readonly NewBaselineEvidence[],
  ): Promise<BaselineEvidence[]>;

  /**
   * Upsert observations (idempotent on (baseline, kind, claim_digest)). A
   * re-analyze of the same revision appends no duplicates. Observations may
   * only be appended while the baseline is 'analyzing' (the guard rejects
   * appends to a terminal baseline — a complete baseline is immutable).
   */
  upsertObservations(
    baselineId: string,
    observations: readonly NewBaselineObservation[],
  ): Promise<BaselineObservation[]>;

  listObservations(baselineId: string): Promise<BaselineObservation[]>;
  listEvidence(baselineId: string): Promise<BaselineEvidence[]>;

  /**
   * CAS transition analyzing → complete. Sets content_digest + finalized_at +
   * terminal_at. The transition guard enforces immutability on terminal rows.
   * Returns the updated baseline, or null if the CAS lost (another worker
   * completed it — convergence; the caller observes the winner's row).
   */
  markComplete(
    baselineId: string,
    contentDigest: string,
    expectedVersion: number,
  ): Promise<ProjectBaseline | null>;

  /**
   * CAS transition analyzing → failed. A failed baseline NEVER carries a
   * 'confirmed' observation (failed analysis cannot produce a false confirmed
   * baseline — the service refuses to mark complete if any observation is
   * confirmed; the trigger + this method enforce it).
   */
  markFailed(
    baselineId: string,
    failureStage: string,
    expectedVersion: number,
  ): Promise<ProjectBaseline | null>;

  /**
   * The authorized confirmation path: atomically transition an
   * inferred/proposed observation to confirmed, setting confirmed_by +
   * confirmed_at. The observation-guard trigger enforces that ONLY
   * inferred/proposed → confirmed is permitted (no silent promotion; proposed
   * → observed is forbidden). confirmedBy is the authorizing user id.
   */
  confirmObservation(
    baselineId: string,
    observationId: string,
    confirmedBy: string,
  ): Promise<BaselineObservation>;
}

// --- Typed error (the WORK-035/036/037 discriminated-class pattern) ---

export const PROJECT_BASELINE_ERROR_CODES = [
  'project-baseline-not-found',
  'project-baseline-not-analyzing',
  'project-baseline-terminal',
  'project-baseline-illegal-transition',
  'project-baseline-revision-unresolvable',
  'project-baseline-confirmation-inconsistent',
  'project-baseline-no-confirmed-on-failed',
] as const;

export type ProjectBaselineErrorCode = (typeof PROJECT_BASELINE_ERROR_CODES)[number];

export class ProjectBaselineError extends Error {
  readonly code: ProjectBaselineErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: ProjectBaselineErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ProjectBaselineError';
    this.code = code;
    this.context = context;
  }
}

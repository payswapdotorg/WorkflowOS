/**
 * GitHub CI evidence ingestion types (GITHUB-006).
 *
 * WORK-015 extends /github with provider-independent CI evidence contracts
 * representing GitHub Actions workflow/check runs + artifacts. GitHub SDK
 * types stay inside /github/internal/; /verification consumes only the
 * provider-independent interfaces declared here.
 *
 * Boundary ownership (frozen architecture §24, §25; architecture-lock.md §51):
 *   /github     owns CI result ingestion — translates GitHub Actions events
 *               into provider-independent CI evidence rows.
 *   /verification owns verification semantics — reads CI evidence rows via
 *               the CiEvidenceIngestionRepository contract and interprets
 *               them as Evidence + CriterionEvidenceMappings.
 *
 * /github MUST NOT evaluate acceptance criteria (GH6-AC-02 — enforced by a
 * static architecture check). It only ingests + translates.
 */

// --- CI artifact reference (provider-independent) ---

/**
 * A reference to a CI artifact (test report, log, build, coverage, etc.).
 *
 * Large artifact BODIES live in the existing ObjectStore abstraction
 * (DATA-003); this reference holds only metadata + an optional storage_key.
 * For small artifacts (e.g. a simple pass/fail line), storage_key may be null
 * and the artifact is represented inline by its name + metadata.
 */
export interface CiArtifactReference {
  /** Artifact name (e.g. 'test-results.xml', 'build.log'). */
  readonly name: string;
  /** MIME / content type if known. */
  readonly contentType?: string;
  /**
   * ObjectStore storage key for the full artifact body. NULL when the
   * artifact has no large body (e.g. a simple CI status row).
   */
  readonly storageKey?: string;
  /**
   * Provider-native external URL (e.g. the GitHub Actions artifact download
   * URL). Kept for traceability; not interpreted by /verification.
   */
  readonly externalUrl?: string;
  /** Artifact size in bytes (when known). */
  readonly sizeBytes?: number;
  /** Additional artifact metadata. */
  readonly metadata?: Record<string, unknown>;
}

// --- Provider-independent CI run representation ---

/**
 * Provider-independent representation of a CI run (workflow run / check run).
 *
 * Translated from GitHub's native `check_run` / `workflow_run` webhook
 * payloads by the /github adapter. /verification consumes this contract.
 *
 * GitHub-native status/conclusion values are preserved verbatim (status,
 * conclusion) so the translation layer (/github) is the ONLY place that maps
 * them to the /verification evidence result vocabulary ('pass' | 'fail' |
 * 'blocked' | 'unknown').
 */
export interface CiRunEvidence {
  /** Stable identity (the wfos_github_ci_evidence row id). */
  readonly id: string;
  /** Project the CI evidence belongs to (tenant scoping). */
  readonly projectId: string;
  /** Provider — always 'github' for this implementation. */
  readonly provider: string;
  /** GitHub-native run identity (used for idempotency). */
  readonly externalRunId: string;
  /** GitHub workflow name (e.g. 'CI', 'build-and-test'). */
  readonly workflowName: string | null;
  /** GitHub check name (when distinct from workflow name). */
  readonly checkName: string | null;
  /** Repository full name (e.g. 'owner/repo'). */
  readonly repositoryFullName: string | null;
  /** Commit / SHA the CI run evaluated. */
  readonly headSha: string | null;
  /** Branch / ref (when applicable). */
  readonly branch: string | null;
  /** GitHub-native status value (e.g. 'completed', 'in_progress'). */
  readonly status: string | null;
  /** GitHub-native conclusion value (e.g. 'success', 'failure', 'neutral'). */
  readonly conclusion: string | null;
  /** Run URL (provider-native). */
  readonly runUrl: string | null;
  /** Run start timestamp. */
  readonly runStartedAt: Date | null;
  /** Run completion timestamp. */
  readonly runCompletedAt: Date | null;
  /** Artifact references (large bodies via ObjectStore). */
  readonly artifactReferences: CiArtifactReference[];
  /** Raw provider metadata (kept for traceability; never interpreted by /verification). */
  readonly providerMetadata: Record<string, unknown>;
  /** Webhook delivery that produced this CI evidence (traceability). */
  readonly webhookEventId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// --- CI evidence ingestion repository (owned by /github) ---

/**
 * Idempotent upsert input for a CI evidence row. Re-processing the same
 * GitHub Actions event (same provider + external_run_id) produces ONE row,
 * updated in place — never duplicates (UNIQUE constraint at the DB level).
 */
export interface IngestCiEvidenceInput {
  /** Project the CI evidence belongs to (resolved from installation → project). */
  projectId: string;
  /** GitHub-native run identity (e.g. the workflow_run id or check_run id). */
  externalRunId: string;
  workflowName?: string | null;
  checkName?: string | null;
  repositoryFullName?: string | null;
  headSha?: string | null;
  branch?: string | null;
  /** GitHub-native status value. */
  status?: string | null;
  /** GitHub-native conclusion value. */
  conclusion?: string | null;
  runUrl?: string | null;
  runStartedAt?: Date | null;
  runCompletedAt?: Date | null;
  artifactReferences?: CiArtifactReference[];
  providerMetadata?: Record<string, unknown>;
  /** Webhook delivery that produced this CI evidence (traceability). */
  webhookEventId?: string | null;
}

/**
 * Repository contract for CI evidence ingestion, owned by /github.
 *
 * /verification consumes this contract (read-only) to discover CI evidence
 * rows that were ingested by /github from GitHub Actions webhook events.
 */
export interface CiEvidenceIngestionRepository {
  /**
   * Idempotent upsert. If a row with the same (provider, external_run_id)
   * already exists, it is updated in place; otherwise a new row is created.
   * Returns the resulting CiRunEvidence row.
   */
  upsert(input: IngestCiEvidenceInput): Promise<CiRunEvidence>;
  /** Find by id. */
  findById(id: string): Promise<CiRunEvidence | null>;
  /** Find by (provider, external_run_id). Used for idempotency checks. */
  findByExternalRunId(provider: string, externalRunId: string): Promise<CiRunEvidence | null>;
  /** List CI evidence for a project (optionally filtered by head_sha). */
  listForProject(projectId: string, opts?: { headSha?: string }): Promise<CiRunEvidence[]>;
}

// --- CI evidence ingestion service (owned by /github) ---

/**
 * Translates GitHub Actions webhook payloads into provider-independent CI
 * evidence. The concrete implementation parses the GitHub-native payload and
 * calls {@link CiEvidenceIngestionRepository.upsert}.
 *
 * /github OWNS this translation. /verification never sees GitHub-native
 * payloads or SDK types.
 */
export interface CiEvidenceIngestionService {
  /**
   * Ingest a GitHub Actions check_run / workflow_run webhook payload.
   * Idempotent on (provider, external_run_id). Returns the resulting CI
   * evidence row, or null when the payload is not a CI event / the
   * repository is not associated with any project.
   */
  ingestFromWebhookPayload(input: {
    /** The webhook delivery id (for traceability). */
    webhookEventId: string;
    /** GitHub event type (e.g. 'check_run', 'workflow_run'). */
    eventType: string;
    /** Raw webhook payload (already validated + persisted as a receipt). */
    payload: string;
  }): Promise<CiRunEvidence | null>;
}

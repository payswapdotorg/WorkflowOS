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
  /**
   * PR #42 round-3 (the governed repository-read boundary made real): the
   * WORK-037 decideForProjectScope decision that governed THIS /github read,
   * recorded in its OWN column (NOT masquerading as a Tool Runtime
   * invocation). NON-NULL when the evidence row came from a governed
   * repository read (the boundary's governedRead()); NULL otherwise. See
   * {@link NewBaselineEvidence.repositoryReadDecision}.
   */
  readonly repositoryReadDecision: 'allow' | 'constrained' | 'deny' | 'ask' | null;
  /**
   * PR #42 round-3: the concrete enforcement effect (the `constrained` effect
   * made OBSERVABLE). NON-NULL when the evidence row came from a governed
   * repository read; NULL otherwise. See
   * {@link RepositoryReadEnforcement}.
   */
  readonly repositoryReadEnforcement: Readonly<RepositoryReadEnforcement> | null;
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

/**
 * The concrete enforcement effect a `constrained` (or boundary-enforced)
 * repository-read decision had on the actual read (PR #42 round-3 + round-4).
 * This is the honest record of "what `constrained` actually did" — recorded
 * on the evidence row so the effect is OBSERVABLE, not just claimed.
 *
 * PR #42 round-4 (the snapshot/fencing protocol): the boundary now ALSO
 * revalidates the policy snapshot AFTER the read completes (the read is
 * performed against the GitHub API, which cannot participate in the
 * database transaction that the WORK-037 policy store uses). The
 * revalidation fields record what the revalidation saw, and the `stale`
 * flag records whether the snapshot that authorized the read was STILL
 * current when the result was committed:
 *
 *   * `revalidated` — whether the boundary revalidated the snapshot after
 *     the read (round-4 fencing — always true for reads that reached the
 *     revalidation step).
 *   * `revalidatedPolicyVersion` — the policy version the revalidation
 *     saw (null = the gate did not surface one / the revalidation did not
 *     run because the read was blocked before reaching it).
 *   * `revalidatedRuleId` — the matched rule id the revalidation saw.
 *   * `stale` — whether the snapshot that authorized the read was NO
 *     LONGER current at revalidation (the version / rule / decision
 *     changed between capture and revalidation). When `stale=true`, the
 *     boundary DISCARDED the read result — the content is NOT persisted
 *     (no evidence row, no observation for that path). The invariant
 *     becomes: "a repository-read result is persisted only if the policy
 *     snapshot that authorized it is still current when the result is
 *     committed." That is achievable even though the GitHub API itself
 *     cannot participate in the database transaction.
 */
export interface RepositoryReadEnforcement {
  /** The WORK-037 policy version snapshot at decision time (drift detection). */
  readonly policyVersion: number | null;
  /** The matched rule id (null = default effect). */
  readonly ruleId: string | null;
  /** Whether the read was actually performed (deny/ask/path-not-allowed/stale -> false). */
  readonly performed: boolean;
  /** Whether maxOutputBytes truncated the observed content. */
  readonly truncated: boolean;
  /** The maxOutputBytes constraint in effect (null = no constraint). */
  readonly maxOutputBytes: number | null;
  /** The byte offset at which truncation occurred (null if not truncated). */
  readonly truncatedAtBytes: number | null;
  /** Whether the candidate-allowlist admitted the path (the boundary enforcement). */
  readonly pathAllowed: boolean;
  /** The decision reason (the WORK-037 reason OR the boundary's refusal reason). */
  readonly reason: string | null;
  // ----- PR #42 round-4: the snapshot/fencing protocol fields -----
  /** Whether the boundary revalidated the snapshot after the read (round-4 fencing). */
  readonly revalidated: boolean;
  /** The policy version at REVALIDATION (null = the revalidation did not run). */
  readonly revalidatedPolicyVersion: number | null;
  /** The matched rule id at REVALIDATION (null = not surfaced / not revalidated). */
  readonly revalidatedRuleId: string | null;
  /** The decision at REVALIDATION (null = not revalidated). */
  readonly revalidatedDecision: 'allow' | 'constrained' | 'deny' | 'ask' | null;
  /**
   * Whether the snapshot that authorized the read was NO LONGER current at
   * revalidation (the version / rule / decision changed between capture and
   * revalidation). When `stale=true`, the boundary DISCARDED the read
   * result — no evidence row, no observation is persisted for that path.
   */
  readonly stale: boolean;
}

/** A new evidence row to persist. */
export interface NewBaselineEvidence {
  readonly source: BaselineEvidenceSource;
  readonly locator: string;
  readonly contentDigest: string | null;
  readonly redacted: boolean;
  // PR #42 round-2 invariant (PRESERVED): NULL for /github-authority reads —
  // the /github read path is NOT a ToolRuntime invocation. Do not manufacture
  // tool_invocation_ids for operations that never went through Tool Runtime.
  readonly toolInvocationId: string | null;
  // PR #42 round-2 invariant (PRESERVED): NULL for /github-authority reads —
  // reserved for "host tool run" audit trail (a ToolRuntime invocation gated
  // by the WORK-037 engine's decide()). The /github read is NOT a host tool
  // run. The WORK-037 project-scoped gate IS consulted at runtime (the
  // boundary refuses to proceed on deny/ask); that consultation is a runtime
  // invariant, not a host-tool-run claim.
  readonly policyDecision: 'allow' | 'constrained' | 'deny' | 'ask' | null;
  // PR #42 round-3 (the governed repository-read boundary made real): the
  // WORK-037 decideForProjectScope decision that governed THIS /github read,
  // recorded in its OWN column (NOT masquerading as a Tool Runtime invocation).
  // NON-NULL when the evidence row came from a governed repository read; NULL
  // for evidence rows that did not come from a governed read (none currently
  // exist — all evidence rows come from governed reads). The architect's
  // round-3 requirement: "record the actual decision/effect without
  // pretending it was a Tool Runtime invocation" — this column records the
  // decision; tool_invocation_id + policy_decision stay NULL.
  readonly repositoryReadDecision: 'allow' | 'constrained' | 'deny' | 'ask' | null;
  // PR #42 round-3: the concrete enforcement effect (the `constrained` effect
  // made OBSERVABLE). Recorded as jsonb on the evidence row so a later
  // auditor can verify the content was read under decision X (policy version
  // V), that maxOutputBytes truncated it to N bytes, that the path was in the
  // candidate allowlist. NULL when the evidence row did not come from a
  // governed repository read.
  readonly repositoryReadEnforcement: Readonly<RepositoryReadEnforcement> | null;
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

// --- PR #42 round-5: the persistence-boundary fence ---

/**
 * PR #42 round-5 (the persistence-boundary fence): a captured policy snapshot
 * at the persistence boundary. The orchestrator captures this snapshot AFTER
 * the analyzer's per-read fence has authorized every evidence row (each under
 * its own per-read V_p) AND BEFORE the persistence transaction begins. The
 * snapshot is the persistence-boundary fence's reference value:
 *
 *   * BEFORE the writes — verify `snapshot` matches each evidence row's
 *     per-read `repository_read_enforcement.policyVersion`. If they differ,
 *     the policy mutated BETWEEN the per-read fence and the persistence
 *     capture — the evidence is stale; the persistence is REJECTED (no
 *     writes happen; the baseline is markFailed).
 *   * INSIDE the transaction (after the writes, before commit) — revalidate
 *     the snapshot (call the gate again) and compare. If the version/rule/
 *     decision changed DURING the writes, the transaction is ROLLED BACK
 *     (zero evidence/observations committed — the architect's invariant:
 *     "a repository-read result is persisted only if the policy snapshot
 *     that authorized it is still current when the result is committed").
 *
 * The fence is a CAS (compare-and-swap) at the persistence boundary. It does
 * NOT claim database-style atomicity across the policy engine and the DB
 * (the policy store cannot participate in the DB transaction). It DETECTS +
 * REJECTS stale snapshots before the result is committed — the same fencing
 * protocol as round-4, extended to cover the persistence window the round-4
 * fence left open.
 *
 * This type lives in /projects (the persistence authority) because the
 * persistence-boundary fence is a STORAGE-level concern: the fence verifies
 * that the policy version stamped on the evidence (by the analyzer's per-read
 * fence) is STILL current when the evidence is committed to the DB. The
 * onboarding orchestrator (src/onboarding/) composes it: it captures the
 * snapshot via the governed-read boundary + passes it through to the
 * repository's persistBaselineWithPolicyFence method.
 */
/**
 * PR #42 round-6 (the database-level fence): which authoritative
 * `wfos_agent_policies` row the snapshot was captured under. The fence uses
 * this to SELECT ... FOR UPDATE the EXACT row (project override vs org
 * default) inside the persistence transaction — locking the same row the
 * policy mutation path (`setProjectPolicy` / `setOrganizationPolicy` /
 * `clearProjectPolicy` / `clearOrganizationPolicy`) touches, so a concurrent
 * mutation must either wait for the persistence transaction to commit OR
 * commit first → the fence's locked read returns the NEWEST committed version
 * → the version predicate rejects → ROLLBACK. `'platform-default'` (or null)
 * means no authoritative DB row exists (the platform default policy); the
 * fence skips the row lock (there is nothing to mutate mid-flight).
 */
export type PersistencePolicySource = 'project' | 'organization' | 'platform-default';

export interface PersistencePolicySnapshot {
  /**
   * PR #42 round-7: the scope source the gate surfaced at capture time. The
   * fence RE-RESOLVES the effective policy INSIDE the persistence
   * transaction (project-override → org-default → platform-default) and
   * compares the effective source against this snapshot.source — if they
   * DIFFER (a row was CREATED or DELETED mid-flight, changing the effective
   * resolution) → ROLLBACK → `fence-stale`. This is the architect's
   * round-7 invariant: assert against the EFFECTIVE policy version/source,
   * NOT merely the old policy row's version. null = the capture failed
   * closed (the gate threw) — the fence skips the source comparison (best-
   * effort, same fail-closed behavior as round-4).
   */
  readonly source: PersistencePolicySource | null;
  /** The WORK-037 policy version at the persistence boundary (drift detection). */
  readonly policyVersion: number | null;
  /** The matched rule id at the persistence boundary (null = default effect / not surfaced). */
  readonly ruleId: string | null;
  /** The decision at the persistence boundary (null = the gate surfaced no decision). */
  readonly decision: 'allow' | 'constrained' | 'deny' | 'ask' | null;
  /** The decision reason (the WORK-037 reason). */
  readonly reason: string | null;
}

/**
 * Input for the fenced persist operation (PR #42 round-5). Bundles everything
 * the repository needs to atomically persist evidence + observations +
 * complete the baseline in ONE DB transaction, under the captured
 * persistence-boundary snapshot.
 */
export interface PersistBaselineInput {
  readonly baselineId: string;
  readonly evidence: readonly NewBaselineEvidence[];
  readonly observations: readonly NewBaselineObservation[];
  readonly contentDigest: string;
  /** The baseline.version captured BEFORE the persist (the CAS predicate). */
  readonly expectedVersion: number;
  /** The captured persistence-boundary policy snapshot (the fence's reference). */
  readonly snapshot: PersistencePolicySnapshot;
  /**
   * PR #42 round-7: the organization the policy scope is anchored to. The
   * fence SELECTs the scope anchor `wfos_organizations` row for this org
   * FOR UPDATE — the SAME lock the mutation paths
   * (`setOrganizationPolicy` / `clearOrganizationPolicy`) acquire — so a
   * concurrent org-policy mutation SERIALIZES against the fence. The lock
   * ALSO blocks a concurrent T2's INSERT of an org-scope policy row via
   * the FK-induced FOR KEY SHARE on the org parent.
   */
  readonly organizationId: string;
  /**
   * PR #42 round-7: the project the policy scope is anchored to. The fence
   * SELECTs the scope anchor `wfos_projects` row for this project FOR
   * UPDATE — the SAME lock the mutation paths (`setProjectPolicy` /
   * `clearProjectPolicy`) acquire — so a concurrent project-policy
   * mutation SERIALIZES against the fence (whether the project policy row
   * is being CREATED, REPLACED, or DELETED). The lock ALSO blocks a
   * concurrent T2's INSERT of a project-scope policy row via the FK-
   * induced FOR KEY SHARE on the project parent — the architect's
   * missing-row case 1 (org policy active, T2 creates project policy) is
   * fenced.
   */
  readonly projectId: string;
  /**
   * PR #42 round-7 (test-only seam for the real-PostgreSQL concurrency
   * regression): an optional callback invoked AFTER the fence acquires the
   * scope-anchor + policy-row locks (FOR UPDATE) + verifies the snapshot
   * against the locked re-resolved effective policy, but BEFORE the writes.
   * The concurrency regression drives a concurrent policy mutation (T2)
   * from inside this hook — T2's INSERT/UPDATE/DELETE blocks on T1's
   * FOR UPDATE locks (the project anchor OR the org anchor OR the policy
   * row itself), proving the fence SERIALIZES against the policy mutation
   * path for in-place mutations, NEW row creations, AND row deletions.
   * No-op (undefined) in production; the field is optional.
   */
  readonly willMutate?: () => Promise<void>;
}

/**
 * The result of the fenced persist operation (PR #42 round-7 — the
 * scope-resolution fence).
 *
 *   * `persisted` — the transaction committed; the baseline is complete; the
 *     evidence rows are returned (with their IDs, for observation linkage by
 *     the caller if needed). The scope-anchor + policy-row locks were held
 *     from the re-resolution through COMMIT; a concurrent mutation either
 *     waited (then applied after commit) or committed first (then the fence
 *     rejected).
 *   * `cas-lost` — the markComplete CAS lost (another worker completed the
 *     baseline first); the transaction was ROLLED BACK (the caller re-reads
 *     the winner's row — convergence). NO evidence/observations from this
 *     call are committed (the winner's evidence is already in).
 *   * `fence-stale` — the scope-resolution fence REJECTED the persist: the
 *     locked re-resolved effective policy's source (project / organization /
 *     platform-default) does NOT match the snapshot's source (a row was
 *     CREATED or DELETED mid-flight, changing the effective resolution), OR
 *     the effective policy_version does NOT match the snapshot's
 *     policyVersion (an in-place mutation committed before this transaction
 *     acquired the lock), OR the per-read snapshots on the evidence rows
 *     mismatch the persistence snapshot (Check B). The transaction was
 *     ROLLED BACK — zero evidence/observations are committed. The baseline
 *     is NOT complete; the caller (orchestrator) markFailed with
 *     failure_stage='policy-snapshot-stale-at-persistence'.
 *   * `fence-revalidation-failed` — RETAINED for contract completeness + the
 *     round-5 fail-closed architecture invariant. The round-7 scope-
 *     resolution fence does NOT produce this variant (the locked re-
 *     resolution replaces the application-level revalidation; a locked-
 *     SELECT failure is a genuine infrastructure error that re-throws).
 *     The caller's markFailed branch for this stage ('policy-snapshot-
 *     revalidation-failed') stays as a defensive no-op reachability guard.
 */
export type PersistBaselineResult =
  | {
      readonly kind: 'persisted';
      readonly baseline: ProjectBaseline;
      readonly evidence: BaselineEvidence[];
    }
  | { readonly kind: 'cas-lost' }
  | {
      readonly kind: 'fence-stale';
      readonly snapshot: PersistencePolicySnapshot;
      readonly revalidated: PersistencePolicySnapshot;
      readonly reason: string;
    }
  | {
      readonly kind: 'fence-revalidation-failed';
      readonly snapshot: PersistencePolicySnapshot;
      readonly reason: string;
    };

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
   * PR #42 round-7 (the SCOPE-RESOLUTION fence): persist evidence +
   * observations + complete the baseline in ONE PostgreSQL transaction whose
   * commit is conditioned on the EFFECTIVE policy resolution remaining at
   * the snapshot's (source, policyVersion). The round-6 fence locked ONLY
   * the row represented by `snapshot.source` — the architect's round-7
   * review of commit `60dda58` established that locking a single policy
   * row does NOT fence policy RESOLUTION: when the current effective
   * source is `organization` (no project policy exists) and a concurrent
   * T2 CREATES a NEW project policy row, the effective policy changes
   * (project now overrides organization) but the locked organization row
   * did NOT change → the round-6 fence let V7 (org) stale evidence commit
   * under the new V1 (project) effective policy. The inverse hole existed
   * when a project policy was DELETED (clearProjectPolicy) and resolution
   * fell back to organization. The architect's invariant:
   *
   *   policy row immutability ≠ effective policy immutability
   *
   * THE ROUND-7 FIX: the fence serializes the ENTIRE scope-resolution
   * decision, not just the currently selected policy document. The fence
   * locks:
   *   * the project scope anchor (wfos_projects row) — FOR UPDATE
   *   * the organization scope anchor (wfos_organizations row) — FOR UPDATE
   *   * the project-scope policy row (if present) — FOR UPDATE
   *   * the org-scope policy row (if present) — FOR UPDATE
   * The anchor locks make a concurrent T2's INSERT/UPDATE/DELETE that can
   * change the effective resolution BLOCK on the anchor (the project anchor
   * blocks a NEW project policy INSERT via the FK-induced FOR KEY SHARE;
   * the org anchor blocks a NEW org policy INSERT similarly). The mutation
   * paths (`setProjectPolicy` / `clearProjectPolicy` /
   * `setOrganizationPolicy` / `clearOrganizationPolicy` in
   * pg-agent-policy-repository.ts) acquire the SAME anchor lock BEFORE the
   * INSERT/UPDATE/DELETE — so the two transactions SERIALIZE against each
   * other even when the effective policy changes because a row is CREATED
   * or DELETED.
   *
   * THE FENCE PROTOCOL:
   *
   *   1. BEGIN TRANSACTION.
   *   2. LOCK the scope ANCHOR rows:
   *      a. SELECT id FROM wfos_projects WHERE id = $proj FOR UPDATE
   *      b. SELECT id FROM wfos_organizations WHERE id = $org FOR UPDATE
   *   3. LOCK the relevant policy rows (present OR absent — the anchor
   *      locks block creation mid-flight):
   *      a. SELECT policy_version FROM wfos_agent_policies
   *           WHERE scope='project' AND organization_id=$org AND project_id=$proj
   *           FOR UPDATE
   *      b. SELECT policy_version FROM wfos_agent_policies
   *           WHERE scope='organization' AND organization_id=$org AND project_id IS NULL
   *           FOR UPDATE
   *   4. RE-RESOLVE the effective policy from the LOCKED rows:
   *      project-override → org-default → platform-default.
   *   5. VERIFY (source, policyVersion) against the snapshot — NOT just
   *      version. If the effective source DIFFERS from the snapshot's
   *      source (a row was CREATED or DELETED mid-flight, changing the
   *      effective resolution) OR the version DIFFERS (an in-place
   *      mutation committed before the lock) → ROLLBACK → `fence-stale`.
   *      This is the architect's round-7 invariant: assert against the
   *      EFFECTIVE policy version/source, NOT merely the old policy row's
   *      version.
   *   6. PER-READ SNAPSHOT VERIFICATION (Check B — retained from round-5):
   *      verify `snapshot.policyVersion` matches each evidence row's per-read
   *      `repository_read_enforcement.policyVersion` (captured by the
   *      analyzer's per-read fence). If ANY differ → ROLLBACK → `fence-stale`.
   *   7. (test seam) If `input.willMutate` is set, invoke it NOW — the
   *      scope-anchor + policy-row locks are held, so a concurrent policy
   *      mutation (T2) driven from the hook BLOCKS on the FOR UPDATE locks
   *      until this transaction commits. No-op in production.
   *   8. WRITES — appendEvidence + upsertObservations + markComplete (CAS on
   *      baseline.version). Lost CAS → ROLLBACK → `cas-lost`. NO post-writes
   *      revalidation — the locks held since steps 2 + 3 serialize against
   *      ANY concurrent mutation for the duration of the writes + commit.
   *   9. COMMIT — releases all the locks. A blocked concurrent mutator (T2)
   *      now proceeds + applies its mutation (the persistence happened-before
   *      the mutation in the serialization order).
   *  10. Return `persisted` with the completed baseline + the evidence rows.
   *
   * SERIALIZATION GUARANTEE (the architect's round-7 requirement): a
   * concurrent policy mutation (via `setProjectPolicy` /
   * `setOrganizationPolicy` / `clearProjectPolicy` /
   * `clearOrganizationPolicy` — all acquire the SAME anchor lock the fence
   * holds) must either:
   *   * WAIT for the persistence transaction to commit (T1 holds the anchor
   *     lock → T2 blocks → T1 commits → T2 applies); OR
   *   * COMMIT first → the fence's locked re-resolution sees the NEW
   *     effective policy → source/version mismatch → ROLLBACK → zero stale
   *     evidence/observations are committed.
   * There is no TOCTOU hole for the missing-row cases because the fence no
   * longer locks a single row — it locks the scope ANCHOR + every relevant
   * row + re-resolves.
   *
   * The `fence-revalidation-failed` result variant is RETAINED in
   * `PersistBaselineResult` for contract completeness + the round-5 fail-closed
   * architecture invariant; the round-7 fence does NOT produce it (the locked
   * re-resolution replaces the application-level revalidation; a locked-
   * SELECT failure is a genuine infrastructure error that re-throws, not a
   * typed fence result).
   *
   * The repository is never coupled to the policy gate directly (the /projects
   * module stays independent of /agents): the snapshot — including `source` —
   * is captured by the orchestrator via the governed-read boundary's
   * `capturePersistenceSnapshot` BEFORE the transaction begins; the fence
   * locks the DB row directly (the same row the mutation path touches).
   */
  persistBaselineWithPolicyFence(
    input: PersistBaselineInput,
  ): Promise<PersistBaselineResult>;

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

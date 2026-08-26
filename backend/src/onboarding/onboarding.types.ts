/**
 * WORK-038: Existing Project Onboarding — the application-layer orchestrator.
 *
 * This directory is NOT a frozen module (it is not under src/modules/) and is
 * NOT an authority. It is an ONBOARDING/APPLICATION CAPABILITY (analogous to
 * src/execution-policy/ and src/benchmark/) that composes the EXISTING
 * domain authorities to produce evidence-backed Project Baseline proposals:
 *
 *   * /github    — the repository + exact-revision authority (GitHubAdapter.getBranch
 *                  resolves the precise commit SHA; ProjectGitHubRepositoryRepository
 *                  resolves the project's repo link). NO GitHub SDK here.
 *   * /projects  — the Project Baseline STORAGE authority (ProjectBaselineRepository).
 *                  The baseline is a project artifact; /projects remains the single
 *                  project authority. This orchestrator owns NO tables.
 *   * /agents    — the governed-tooling + policy boundary (ToolPolicyGate seam +
 *                  the AgentPolicyEngine's decideForProjectScope project-scoped
 *                  entry). Onboarding analysis IS an agent/tool execution
 *                  activity and respects the policy gate.
 *
 * The orchestrator NEVER mutates workflow / verification / review state, NEVER
 * auto-freezes architecture (proposed architecture is a PROPOSED baseline
 * observation, never an ArchitectureVersion), NEVER stores credentials
 * (secret-shaped content is redacted via the platform observation-redaction
 * util before persistence), and NEVER imports provider SDKs (no pg/redis/
 * pglite/github-sdk here — those stay in /platform + /github internal).
 *
 * Provenance is the central invariant: every reconstructed fact is
 * observed/inferred/confirmed/proposed, never collapsed into a confidence
 * number, never silently promoted.
 */
import type { ToolFamily } from '@platform/tools/tool-contracts.js';
import type {
  ProjectScopedPolicyDecision,
  ToolPolicyDecisionValue,
  ToolPolicyRequest,
} from '@modules/agents/index.js';
import type {
  BaselineAnalysisMode,
  BaselineEvidenceSource,
  NewBaselineEvidence,
  NewBaselineObservation,
  RepositoryReadEnforcement,
} from '@modules/projects/index.js';

// Re-export ProjectScopedPolicyDecision (defined in /agents — the engine
// produces it; the dependency direction is onboarding → agents) so the
// governed repository-read boundary + the project-scoped gate seam can
// reference it without reaching across the package boundary.
export type { ProjectScopedPolicyDecision };

// --- The project-scoped policy gate (the WORK-037 boundary for onboarding) ---

/**
 * The project-scoped policy gate. Implemented by AgentPolicyEngine
 * (decideForProjectScope) — the SAME engine + matcher + decision vocabulary
 * as the native execution decide() path, but scoped directly by
 * (projectId, organizationId) since onboarding is not a Work Item execution
 * and has no wfos_executions row. Onboarding is NON-INTERACTIVE: an 'ask'
 * decision is returned as-is (the analyzer records it as a blocked
 * observation; no pending approval is created).
 *
 * PR #42 round-3: decideForProjectScope returns the richer
 * {@link ProjectScopedPolicyDecision} so the governed repository-read
 * boundary can capture the policy version snapshot (drift detection) and
 * the matched rule id (forensic provenance) AT DECISION TIME — the decision
 * and the version are bound in the same call. The decision type lives in
 * /agents (the engine produces it; onboarding re-imports it).
 */
export interface ProjectScopedPolicyGate {
  decideForProjectScope(
    request: ToolPolicyRequest,
    projectId: string,
    organizationId: string,
  ): Promise<ProjectScopedPolicyDecision>;
}

// --- The repository content port (how file content at a revision is read) ---

/**
 * The seam for reading file content at a precise repository revision. The
 * onboarding domain holds NO GitHub credentials and NO GitHub SDK — this port
 * is the boundary. The PRODUCTION wiring (app.ts) injects
 * {@link GitHubRepositoryContentPort} (src/onboarding/internal/
 * github-content-port.ts), which delegates to the /github authority's
 * GitHubAdapter.getFileContent/listDir — the adapter is the only SDK caller.
 * Tests inject an in-memory provider for deterministic governed analysis.
 * The `installationId` is resolved by the orchestrator from the project's
 * /github repository link and carried in the AnalysisContext; the analyzer
 * passes it to the port per-call (the port holds no credential state).
 */
export interface RepositoryContentPort {
  /**
   * Read a file's text content at the exact revision. Returns null when the
   * path does not exist at that revision. The returned digest is sha256 of
   * the content (reproducibility).
   */
  readFile(
    owner: string,
    repository: string,
    commitSha: string,
    path: string,
    installationId: string,
  ): Promise<{ readonly content: string; readonly contentDigest: string } | null>;

  /**
   * List directory entries at the exact revision. Returns [] when the
   * directory does not exist.
   */
  listDir(
    owner: string,
    repository: string,
    commitSha: string,
    path: string,
    installationId: string,
  ): Promise<readonly { readonly name: string; readonly type: 'file' | 'dir' }[]>;
}

// --- The repository analyzer (produces observations + evidence) ---

/** The context handed to the analyzer for one baseline reconstruction. */
export interface AnalysisContext {
  readonly baselineId: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly installationId: string;
  /** The IMMUTABLE exact repository revision (a real Git commit SHA). */
  readonly baselineCommitSha: string;
  readonly revisionRef: string;
  /** The governed-analysis run identity (links to evidence rows). */
  readonly analysisRunId: string;
  readonly analysisMode: BaselineAnalysisMode;
}

/** The analyzer's output: provenance-tagged observations + their evidence. */
export interface AnalysisResult {
  readonly observations: readonly NewBaselineObservation[];
  readonly evidence: readonly NewBaselineEvidence[];
  /** sha256 of the canonical observation set (the reproducibility fingerprint). */
  readonly contentDigest: string;
}

/**
 * The repository analyzer port. The default implementation
 * (GovernedFilesystemAnalyzer) routes every candidate read through the
 * project-scoped ToolPolicyGate, records the decision as evidence, redacts
 * secrets, and produces observed/inferred/proposed observations. Deep
 * stack/security/deployment scanning is WORK-039+ (STRICTLY OUT OF SCOPE).
 */
export interface RepositoryAnalyzer {
  analyze(ctx: AnalysisContext): Promise<AnalysisResult>;
}

// --- The onboarding orchestrator ---

/** The resolved repository link (from the /github authority). */
export interface ResolvedRepositoryLink {
  readonly projectGithubRepositoryId: string;
  readonly owner: string;
  readonly repository: string;
  readonly installationId: string;
  readonly defaultBranch: string;
  readonly organizationId: string;
}

/** Input for the onboarding flow (connect + analyze a repository revision). */
export interface OnboardRepositoryInput {
  readonly projectId: string;
  /**
   * The ref to analyze. Defaults to the repository's default branch. The
   * orchestrator resolves it to the EXACT commit SHA via /github getBranch;
   * the SHA (not the ref) is the baseline identity.
   */
  readonly ref?: string;
  /** native (governed host analysis) | external (provider-reported). */
  readonly analysisMode?: BaselineAnalysisMode;
}

/** The result of an onboarding flow: the baseline header + the analysis run. */
export interface OnboardResult {
  readonly baseline: {
    readonly id: string;
    readonly state: string;
    readonly version: number;
    readonly baselineCommitSha: string;
    readonly revisionRef: string;
    readonly analysisMode: BaselineAnalysisMode;
    readonly analysisRunId: string | null;
    readonly contentDigest: string | null;
    /**
     * Where analysis failed (failed rows only; the durable forensic). Set
     * to 'repository-content-unavailable' when a content read hit an
     * infrastructure failure (PR #42 round-2 Blocker B). Null for non-
     * failed rows.
     */
    readonly failureStage: string | null;
    readonly finalizedAt: Date | null;
  };
  /** Whether this call performed the analysis (false = idempotent re-entry). */
  readonly analyzed: boolean;
}

// --- Evidence/observation helpers (shared by the analyzer) ---

/** A governed read request the analyzer issues (one per candidate path). */
export interface GovernedReadRequest {
  readonly path: string;
  readonly family: ToolFamily;
  /** 'read' (a file) | 'list' (a directory). The boundary refuses others. */
  readonly operation: string;
}

/**
 * The bound governance record for ONE governed repository read (PR #42
 * round-3 + round-4). This is the honest, atomic record of the decision that
 * authorized the read AND the concrete enforcement effect the boundary
 * applied. It is NOT a Tool Runtime invocation record — there is no
 * tool_invocation_id here (the /github read path is not a ToolRuntime
 * invocation). It is recorded on the evidence row in its OWN columns
 * (repository_read_decision + repository_read_enforcement), distinct from
 * the Tool Runtime columns (tool_invocation_id + policy_decision stay NULL).
 *
 * PR #42 round-4 (the snapshot/fencing protocol): `stale=true` means the
 * policy snapshot that authorized the read was NO LONGER current at
 * revalidation (the version / rule / decision changed between capture and
 * revalidation — a concurrent policy mutation committed DURING the read).
 * When `stale=true`, the boundary DISCARDED the read result — `content` is
 * null, `performed` is false, and the analyzer persists NO evidence row and
 * NO observation for that path. The invariant: "a repository-read result is
 * persisted only if the policy snapshot that authorized it is still current
 * when the result is committed" — achievable even though the GitHub API
 * itself cannot participate in the database transaction. The revalidation
 * metadata (the version / rule / decision the revalidation saw) is in the
 * `enforcement` record for forensic provenance.
 */
export interface RepositoryReadGovernance {
  /** The WORK-037 decideForProjectScope decision (allow/constrained/deny/ask). */
  readonly decision: ToolPolicyDecisionValue;
  /** The decision reason (the WORK-037 reason OR the boundary's refusal reason). */
  readonly reason: string | null;
  /** The policy version snapshot at decision time (drift detection; null when the gate did not surface one). */
  readonly policyVersion: number | null;
  /** The matched rule id (null = default effect). */
  readonly ruleId: string | null;
  /** Whether the read was actually performed (deny/ask/path-not-allowed/stale -> false). */
  readonly performed: boolean;
  /**
   * PR #42 round-4 (the snapshot/fencing protocol): whether the snapshot
   * that authorized the read was NO LONGER current at revalidation. When
   * `stale=true`, the boundary DISCARDED the read result — no evidence row,
   * no observation is persisted for that path. The revalidation metadata is
   * in {@link enforcement} (revalidatedPolicyVersion + revalidatedRuleId +
   * revalidatedDecision).
   */
  readonly stale: boolean;
  /** The concrete enforcement effect (what `constrained` actually did — OBSERVABLE). */
  readonly enforcement: Readonly<RepositoryReadEnforcement>;
}

/**
 * The outcome of a governed repository read: the content (null when the read
 * was blocked, the path was absent, OR the snapshot was stale) + the bound
 * governance record. The decision and the content are returned by ONE
 * boundary method — there is no caller-interleavable check-then-act gap (PR
 * #42 round-3). PR #42 round-4 adds the snapshot/fencing protocol: the
 * boundary revalidates the policy snapshot AFTER the read; if the snapshot
 * was stale (a concurrent policy mutation committed during the read), the
 * content is DISCARDED (null) and {@link governance.stale} is true — the
 * analyzer persists NO evidence row and NO observation for that path.
 */
export interface GovernedReadOutcome {
  readonly request: GovernedReadRequest;
  readonly content: { readonly content: string; readonly contentDigest: string } | null;
  readonly governance: RepositoryReadGovernance;
}

/**
 * PR #42 round-3 + round-4 + round-5 — the governed repository-read boundary
 * for /github reads.
 *
 * The architect's round-3 review identified that the round-2 path was a
 * check-then-act authorization window:
 *
 *   PolicyGate.decideForProjectScope()            (decision at T1)
 *     -> if allow/constrained
 *       -> GitHubAdapter.getFileContent/listDir()  (read at T2 > T1)
 *
 * with NOTHING atomic tying the authorization decision to the actual read,
 * and `constrained` having no concrete enforcement effect. The round-3
 * boundary made the governance real: {@link governedRead} is a SINGLE
 * authoritative operation that captures the WORK-037 decision, enforces it
 * (deny/ask/path-not-allowed/operation-not-read -> no read), performs the
 * read under the captured decision, applies the `constrained` enforcement,
 * and returns the bound decision+effect+content.
 *
 * The architect's round-4 review identified that the round-3 boundary STILL
 * did not actually achieve atomicity with respect to policy changes:
 * `decideForProjectScope()` (V7) and the GitHub read are two separate
 * asynchronous operations against two different authorities. A concurrent
 * policy update CAN commit between them:
 *
 *   T1  policy = ALLOW, version 7
 *       ↓
 *   T1  governedRead() captures V7
 *       ↓
 *   T2  policy mutates to DENY, version 8
 *       ↓
 *   T1  GitHubAdapter.getFileContent(...)
 *       ↓
 *   T1  read succeeds — UNDER A POLICY (V8) THAT WOULD HAVE DENIED IT
 *
 * Being inside one JavaScript method does not make those operations atomic.
 * The round-3 `policyVersion` snapshot made the race OBSERVABLE, but did NOT
 * prevent it. The round-4 fix is an explicit SNAPSHOT/FENCING PROTOCOL:
 *
 *   1. Resolve policy snapshot (capture decision + policyVersion + rule +
 *      constraints)
 *   2. Enforce the snapshot decision (deny/ask/path-not-allowed/operation-
 *      not-read -> NO read; the decision is recorded honestly)
 *   3. Perform the repository read under the captured snapshot
 *   4. Apply the `constrained` enforcement (maxOutputBytes truncation) on
 *      the captured snapshot's constraints
 *   5. REVALIDATE the policy snapshot (call decideForProjectScope AGAIN,
 *      compare the version + rule + decision)
 *   6. If the snapshot is STALE (the version / rule / decision changed
 *      between capture and revalidation):
 *        discard the read result (content = null)
 *        set stale = true, performed = false
 *        record the revalidation metadata (the V8 the revalidation saw)
 *        do NOT persist an evidence row or observation for that path
 *      else (the snapshot is still current):
 *        return the bound outcome (content + governance + enforcement)
 *
 * The architect's round-5 review identified that the round-4 fence protects
 * the READ window but does NOT protect the SUBSEQUENT PERSISTENCE window:
 *
 *   capture V7 -> read -> revalidate V7 (round-4 fence passes here) ->
 *   policy mutates V7 -> V8 -> appendEvidence(V7) -> upsertObservations(V7)
 *   -> markComplete
 *
 * The architect's round-5 required fix: a "persistence-boundary CAS /
 * transactional policy snapshot guard." The round-5 boundary exposes a
 * SECOND method — {@link capturePersistenceSnapshot} — that the orchestrator
 * calls AFTER analyze() returns + BEFORE the persistence transaction begins.
 * The snapshot is the persistence-boundary fence's reference value. The
 * /projects repository's `persistBaselineWithPolicyFence` method wraps the
 * appendEvidence + upsertObservations + markComplete in ONE DB transaction
 * + performs a CAS check on the snapshot INSIDE the transaction (before
 * commit). If the snapshot is stale at any fence check (pre-writes, per-read
 * verification, post-writes), the transaction is ROLLED BACK — zero stale
 * evidence/observations are committed.
 *
 * The invariant (round-4 + round-5): "a repository-read result is persisted
 * only if the policy snapshot that authorized it is still current when the
 * result is committed." That is achievable even though the GitHub API itself
 * cannot participate in the database transaction the WORK-037 policy store
 * uses. The boundary does NOT claim database-style atomicity across the
 * policy engine and the GitHub API — it claims a fencing protocol that
 * DETECTS + REJECTS stale snapshots before the result is persisted (round-4,
 * at the read boundary) AND before the result is committed (round-5, at the
 * persistence boundary).
 *
 * WHY THE ALTERNATIVE PATH (not the preferred Tool Runtime adaptation):
 * the frozen WORK-036 `DefaultToolRuntime.invoke()` is structurally coupled
 * to ExecutionSession (must be 'running') + Workspace (must be 'ready') +
 * WorktreeMaterializer (host-path re-resolution) + a family ToolExecutor.
 * Onboarding is NOT a Work Item execution — it has NO wfos_executions row,
 * NO ExecutionSession, NO Workspace, NO host worktree. Routing onboarding
 * reads through `invoke()` would require manufacturing a synthetic session/
 * workspace/worktree — exactly the "fake toolInvocationId" smell the
 * architect already rejected in round-2. Adapting the frozen WORK-036
 * boundary to support a session-less, workspace-less, worktree-less read
 * path is a substantial refactor of a FROZEN boundary, out of scope for
 * WORK-038. The architect's handoff explicitly sanctioned the non-executing
 * /github read path IF made a real, distinct, atomic boundary — which this
 * is. It REUSES the WORK-037 decideForProjectScope engine (no parallel
 * engine — same matcher, same document, same decision vocabulary).
 *
 * `constrained` enforcement (made concrete + verifiable):
 *   * maxOutputBytes — truncate the observed content to N bytes, flag
 *     truncated=true, truncatedAtBytes=N, recompute contentDigest on the
 *     TRUNCATED content (the digest reflects what was actually observed).
 *   * path-allowlist — the boundary only admits reads of paths in the
 *     declared candidate set; an arbitrary path -> pathAllowed=false,
 *     performed=false, decision='deny' (even an allow policy cannot read an
 *     arbitrary path through this boundary).
 *   * read-only — the boundary only supports read/list operations; any
 *     other operation is refused (performed=false).
 *
 * Policy drift prevention (round-4 + round-5 fencing): the snapshot is
 * captured at the START of governedRead(), the read is performed under it,
 * the snapshot is REVALIDATED at the END of governedRead() (round-4), AND
 * the persistence-boundary snapshot is captured + revalidated inside the
 * persistence transaction (round-5). If a snapshot is stale at any check,
 * the result is DISCARDED (round-4: no evidence row; round-5: the
 * transaction is rolled back — zero evidence/observations are committed).
 */
export interface GovernedRepositoryReadPolicy {
  /**
   * The single authoritative operation boundary for a /github read. Captures
   * the WORK-037 decision, enforces it, performs the read under the captured
   * decision, applies the `constrained` enforcement, REVALIDATES the policy
   * snapshot (round-4 fencing), and returns the bound decision+effect+content
   * (or a stale outcome with the content discarded). There is NO check-then-
   * act window at this API.
   *
   * Infrastructure failures (the content port throws — GitHub unavailable,
   * authentication failure, API failure, content retrieval infrastructure
   * failure) propagate as a typed {@link OnboardingAnalysisError} (code
   * 'repository-content-unavailable') so the orchestrator can markFailed the
   * baseline — the baseline must NEVER reach 'complete' when the required
   * repository analysis could not actually inspect the repository (PR #42
   * round-2 Blocker B, preserved). Expected-missing (the port returns
   * null/[]) is NOT an infrastructure failure — the boundary returns
   * content=null + performed=true (the read happened; the path was absent).
   *
   * Snapshot staleness (round-4 fencing) is NOT an infrastructure failure —
   * the boundary returns a stale outcome (content=null, performed=false,
   * stale=true) and the analyzer skips the evidence row + observation for
   * that path. The baseline still completes (the other reads' evidence is
   * still valid under their own revalidated snapshots).
   */
  governedRead(
    request: GovernedReadRequest,
    ctx: AnalysisContext,
  ): Promise<GovernedReadOutcome>;

  /**
   * PR #42 round-5 (the persistence-boundary fence): capture the CURRENT
   * policy snapshot at the persistence boundary. The orchestrator calls
   * this AFTER `analyze()` returns (every evidence row has its per-read
   * snapshot from the round-4 fence) AND BEFORE the persistence transaction
   * begins. The returned snapshot is the persistence-boundary fence's
   * reference value — the /projects repository's `persistBaselineWithPolicyFence`
   * method revalidates it INSIDE the DB transaction (pre-writes + post-writes
   * + per-read verification) + rolls back if it is stale.
   *
   * The captured snapshot is the CURRENT policy version at the persistence
   * boundary. If the policy mutated BETWEEN the per-read fence and this
   * capture (the architect's round-5 regression scenario), the snapshot
   * differs from the evidence's per-read policyVersion — the per-read
   * verification inside the transaction catches the mismatch + rolls back
   * (zero stale evidence/observations are committed).
   *
   * The decision is fetched with a synthetic 'persist-baseline' request
   * (the fence uses ONLY the policyVersion + ruleId for drift detection;
   * the decision itself is NOT enforced at the persistence boundary — the
   * per-read fence already enforced it for each individual read). The
   * synthetic request keeps the gate's API stable (it always takes a
   * ToolPolicyRequest — no separate "fetch current version" method is
   * added to the WORK-037 gate, keeping that boundary frozen).
   *
   * If the gate surfaces no policyVersion (a test fake returning
   * `{ decision: 'allow' }`), the fence falls back to ruleId + decision
   * comparison. The production gate (AgentPolicyEngine) always surfaces a
   * real policyVersion, so the fence is fully effective in production.
   *
   * If the gate FAILS to resolve a decision (it throws), the boundary FAILS
   * CLOSED: the returned snapshot has a null policyVersion + null ruleId +
   * null decision. The persistence fence's revalidation will compare it
   * against a fresh revalidation (which will ALSO fail-closed to null) —
   * both null = no drift signal = stale=false (best-effort, same as the
   * round-4 fence's behavior for gates that surface no version). The
   * orchestrator logs the failure (forensic) + proceeds with the best-effort
   * snapshot.
   */
  capturePersistenceSnapshot(
    ctx: AnalysisContext,
  ): Promise<import('@modules/projects/index.js').PersistencePolicySnapshot>;
}

/** Convenience: the evidence-source vocabulary (mirrors the DB CHECK). */
export type { BaselineEvidenceSource };

/**
 * The onboarding service — the application-layer orchestrator. Wires the
 * /github authority (revision resolution) + the governed analyzer (policy
 * gate + content port) + the /projects baseline storage. Crash-safe +
 * idempotent (re-analyzing the same revision returns the same baseline).
 */
export interface OnboardingService {
  /**
   * Connect + analyze a repository revision. Idempotent per (project, repo,
   * exact commit): a re-analyze of the same revision returns the SAME
   * baseline (no second baseline, no duplicate observations). Crash-safe:
   * an interrupted analysis sits in 'analyzing' and is re-driven by a retry.
   */
  onboard(input: OnboardRepositoryInput): Promise<OnboardResult>;
}

// Re-export the policy-request shape so the analyzer can build requests.
export type { ToolPolicyRequest };

// --- Typed errors (the WORK-035/036/037 discriminated-class pattern) ---
//
// PR #42 round-2 review (Blocker B): the analyzer MUST distinguish
// "expected missing" (file absent / directory absent — the port returns
// null/[] — the analyzer continues, the baseline still completes) from
// "infrastructure / content-provider failure" (the port THROWS — GitHub
// unavailable, authentication failure, API failure, content retrieval
// infrastructure failure). The latter propagates as a typed
// OnboardingAnalysisError so the orchestrator can markFailed the baseline
// (a baseline must NEVER reach 'complete' when the required repository
// analysis could not actually inspect the repository). The orchestrator
// surfaces the failure stage through the route as 502 (bad gateway — the
// content provider is unavailable) so the caller distinguishes
// infrastructure failure from a successful metadata-only baseline.

/**
 * The sanctioned onboarding-analysis failure codes. The orchestrator maps
 * these to markFailed failure_stage values (forensic provenance) and the
 * route maps them to HTTP status codes (502 for infrastructure failures).
 */
export const ONBOARDING_ANALYSIS_ERROR_CODES = [
  // The repository content provider (the /github GitHubAdapter, or a test
  // fake of it) threw an infrastructure failure — GitHub unavailable,
  // authentication failure, API failure, content retrieval infrastructure
  // failure. The baseline must NOT reach 'complete' on this; the
  // orchestrator markFailed with failure_stage='repository-content-unavailable'.
  'repository-content-unavailable',
  // A content read returned content that failed validation in a way that
  // is NOT a path-not-found (e.g., a directory listing where a file was
  // expected). Reserved for future strict content-shape checks.
  'repository-content-malformed',
] as const;

export type OnboardingAnalysisErrorCode =
  (typeof ONBOARDING_ANALYSIS_ERROR_CODES)[number];

/**
 * A typed onboarding-analysis failure. Thrown by the analyzer when a
 * content read fails with an infrastructure failure (NOT a path-not-found —
 * those return null/[] and the analyzer continues). The orchestrator
 * catches this and markFailed the baseline so it NEVER reaches 'complete'
 * on a content-provider failure.
 */
export class OnboardingAnalysisError extends Error {
  readonly code: OnboardingAnalysisErrorCode;
  /** The failing candidate locator (path) — for forensic provenance. */
  readonly failingLocator: string | null;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: OnboardingAnalysisErrorCode,
    message: string,
    options: {
      failingLocator?: string | null;
      cause?: unknown;
      context?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OnboardingAnalysisError';
    this.code = code;
    this.failingLocator = options.failingLocator ?? null;
    this.context = options.context ?? {};
  }
}

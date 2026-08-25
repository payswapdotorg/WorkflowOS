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
  ToolPolicyDecision,
  ToolPolicyRequest,
} from '@modules/agents/index.js';
import type {
  BaselineAnalysisMode,
  BaselineEvidenceSource,
  NewBaselineEvidence,
  NewBaselineObservation,
} from '@modules/projects/index.js';

// --- The project-scoped policy gate (the WORK-037 boundary for onboarding) ---

/**
 * The project-scoped policy gate. Implemented by AgentPolicyEngine
 * (decideForProjectScope) — the SAME engine + matcher + decision vocabulary
 * as the native execution decide() path, but scoped directly by
 * (projectId, organizationId) since onboarding is not a Work Item execution
 * and has no wfos_executions row. Onboarding is NON-INTERACTIVE: an 'ask'
 * decision is returned as-is (the analyzer records it as a blocked
 * observation; no pending approval is created).
 */
export interface ProjectScopedPolicyGate {
  decideForProjectScope(
    request: ToolPolicyRequest,
    projectId: string,
    organizationId: string,
  ): Promise<ToolPolicyDecision>;
}

// --- The repository content port (how file content at a revision is read) ---

/**
 * The seam for reading file content at a precise repository revision. The
 * onboarding domain holds NO GitHub credentials and NO GitHub SDK — this port
 * is the boundary. The default production wiring (app.ts) injects a content
 * provider that fetches via the /github authority when it exposes content
 * reads; tests inject an in-memory provider for deterministic governed
 * analysis. When no provider is wired, the analyzer produces only
 * metadata-derived observations (the governed path is still consulted for
 * every candidate read — the policy decision is recorded as evidence even
 * when content is unavailable).
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
  readonly operation: string;
}

/** A governed read outcome (the decision + optional content). */
export interface GovernedReadOutcome {
  readonly request: GovernedReadRequest;
  readonly decision: ToolPolicyDecision;
  readonly invocationId: string;
  readonly content: { readonly content: string; readonly contentDigest: string } | null;
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

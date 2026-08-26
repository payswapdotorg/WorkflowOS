/**
 * WORK-039: Repository and Context Intelligence — the application/context-
 * intelligence capability that consumes WORK-038 Project Baselines + the
 * existing /architecture, /requirements, /work-items, /github, /agents,
 * /verification, /reviews authorities to assemble better implementation and
 * maintenance contexts.
 *
 * This directory is NOT a frozen module (it is not under src/modules/) and is
 * NOT an authority. It is an APPLICATION/CONTEXT-INTELLIGENCE CAPABILITY
 * (analogous to src/onboarding/, src/execution-policy/, src/benchmark/) that
 * composes the EXISTING domain authorities to produce ranked, explainable
 * context selections:
 *
 *   * /projects — the context-index STORAGE authority (the
 *                  ProjectContextIndexRepository). The index is a project
 *                  artifact; /projects remains the single project authority.
 *                  This orchestrator owns NO tables.
 *   * /github    — the repository + commit authority (read-only; the baseline
 *                  already resolved the exact revision). NO GitHub SDK here.
 *   * /architecture, /requirements, /work-items — read-only authority
 *                  references (NEVER duplicated; the context items POINT at
 *                  architecture versions / requirements / work items, they
 *                  never become them).
 *   * /agents    — the governed-tooling + policy boundary (the optional
 *                  GovernedHostInspector runs inside a Workspace + uses
 *                  ToolRuntime.invoke() for every tool call; the
 *                  ToolPolicyGate is respected; no fabricated evidence).
 *
 * THE MOST IMPORTANT DISTINCTION (the WORK-039 prompt):
 *   SOURCE FACT            — "src/api/users.ts exists."           (the repo)
 *   BASELINE OBSERVATION   — "The repository contains an Express API."
 *   CONTEXT INDEX          — "These repository artifacts are relevant."  (this)
 *   AUTHORITATIVE ARCH     — "ArchitectureVersion X declares this boundary."
 * These concepts are NEVER collapsed. The capability ranks/retrieves context;
 * it does NOT silently promote context into architecture truth.
 *
 * PROVENANCE PRESERVATION. Every context item carries the SAME provenance
 * vocabulary as WORK-038 (observed | inferred | confirmed | proposed). The
 * ranker's relevance_score is ADVISORY ONLY — ranking NEVER promotes
 * provenance (observed+high stays observed; inferred+high stays inferred).
 *
 * REPOSITORY REVISION IS FUNDAMENTAL. A context index is ALWAYS pinned to a
 * concrete baseline_commit_sha. Context from commit A is NEVER silently
 * presented as context from commit B. The detectStale advisory surfaces
 * "this baseline's commit is not the current repo HEAD" — it never swaps
 * the baseline under the caller.
 *
 * The orchestrator NEVER mutates workflow / verification / review / execution
 * state, NEVER auto-freezes architecture (architecture observations in the
 * index are REFERENCES to ArchitectureVersion ids, never an auto-created
 * ArchitectureVersion), NEVER stores credentials (secret-shaped content is
 * already redacted by WORK-038; the redacted flag is preserved, never
 * reversed), and NEVER imports provider SDKs (no pg/redis/pglite/github-sdk
 * here — those stay in /platform + /github internal).
 */
import type {
  ProjectContextIndex,
  ContextItem,
  ContextItemKind,
  ContextItemSource,
  ContextItemProvenance,
  ContextIndexQueryKind,
  RepositoryIntelligenceError,
  RepositoryIntelligenceErrorCode,
  ProjectContextIndexRepository,
  ProjectBaselineRepository,
} from '@modules/projects/index.js';
import type { GitHubAdapter } from '@modules/github/index.js';
import type { ProjectGitHubRepositoryRepository } from '@modules/github/index.js';
import type { ArchitectureVersionRepository, ArchitectureRepository } from '@modules/architecture/index.js';
import type { RequirementRepository, AcceptanceCriterionRepository } from '@modules/requirements/index.js';
import type { WorkItemRepository, WorkItemRequirementRepository, WorkItemCriterionRepository } from '@modules/work-items/index.js';
import type { Logger } from '@platform/index.js';

// Re-export the storage-layer types so capability consumers (the route,
// future execution layer) import from the capability barrel only.
export type {
  ProjectContextIndex,
  ContextItem,
  ContextItemKind,
  ContextItemSource,
  ContextItemProvenance,
  ContextIndexQueryKind,
  RepositoryIntelligenceError,
  RepositoryIntelligenceErrorCode,
  ProjectContextIndexRepository,
  ProjectBaselineRepository,
  GitHubAdapter,
  ProjectGitHubRepositoryRepository,
  ArchitectureVersionRepository,
  ArchitectureRepository,
  RequirementRepository,
  AcceptanceCriterionRepository,
  WorkItemRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
};

// ---------------------------------------------------------------------------
// The query shape (the input to buildIndex / retrieve).
// ---------------------------------------------------------------------------

export interface ContextIndexQuery {
  readonly projectId: string;
  readonly baselineId: string;
  readonly kind: ContextIndexQueryKind;
  /** The concrete authoritative ref (e.g. work_item_id; NULL for freeform). */
  readonly queryRef: string | null;
  /** The deterministic, explainable signal set the ranker consults. */
  readonly queryTerms: ContextQueryTerms;
}

/**
 * The deterministic signal set. Each field is OPTIONAL — the ranker consults
 * whichever are present. The signals are EXPLAINABLE: each contributes a
 * discrete weight + a human-readable reason fragment to every selected item.
 * No opaque AI-generated context (the ranker's output is fully traceable).
 */
export interface ContextQueryTerms {
  /** Work-item-derived terms (title/objective/scope tokens) matched against file/module/observation text. */
  readonly workItemTerms?: readonly string[];
  /** Architecture-version refs (ArchitectureVersion ids) — items referenced by these versions are selected. */
  readonly architectureRefs?: readonly string[];
  /** Requirement refs (Requirement ids) — items referenced by these requirements are selected. */
  readonly requirementRefs?: readonly string[];
  /** Test patterns (file globs / test names) — items matching these are selected. */
  readonly testPatterns?: readonly string[];
  /** Dependency refs (dependency observations) — items referenced by these deps are selected. */
  readonly dependencyRefs?: readonly string[];
  /** Freeform terms (ad-hoc tokens) for the 'freeform' query kind. */
  readonly freeformTerms?: readonly string[];
}

// ---------------------------------------------------------------------------
// The context source (the source-fact reader interface).
// ---------------------------------------------------------------------------

/**
 * A candidate context item produced by a source. The ranker scores these +
 * produces the final ContextItem set (with relevance_score + relevance_reason).
 * The source carries the provenance + the evidence_ref + the authority_ref —
 * these are NEVER mutated by the ranker (provenance preservation).
 */
export interface ContextSourceItem {
  readonly kind: ContextItemKind;
  readonly locator: string;
  readonly source: ContextItemSource;
  readonly provenance: ContextItemProvenance;
  readonly contentDigest: string | null;
  readonly redacted: boolean;
  readonly evidenceRef: readonly string[];
  /** REFERENCES to authoritative domains (NEVER the authority itself). */
  readonly authorityRef: Readonly<Record<string, unknown>>;
  /** The raw text the ranker matches against (e.g. file path, observation claim text, requirement title). */
  readonly matchText: string;
}

/**
 * The source-fact reader. Reads baseline observations + evidence from
 * /projects (via ProjectBaselineRepository) + architecture/requirements/
 * work-items as REFERENCES ONLY (no creation) + repository structure from
 * /github (read-only). All reads produce ContextSourceItem candidates with
 * provenance preserved + authority_ref pointing back to the authoritative
 * domain (never duplicating it).
 */
export interface ContextSource {
  readCandidates(query: ContextIndexQuery, ctx: ContextResolutionContext): Promise<readonly ContextSourceItem[]>;
}

// ---------------------------------------------------------------------------
// The ranker (deterministic, explainable, NEVER promotes provenance).
// ---------------------------------------------------------------------------

/**
 * The ranker's output — a ContextSourceItem scored + explained. The
 * relevance_score is ADVISORY ONLY (never authority); the relevance_reason
 * is a human-readable chain of the signals that selected the item.
 */
export interface RankedContextItem {
  readonly kind: ContextItemKind;
  readonly locator: string;
  readonly source: ContextItemSource;
  readonly provenance: ContextItemProvenance;
  readonly contentDigest: string | null;
  readonly redacted: boolean;
  readonly evidenceRef: readonly string[];
  readonly authorityRef: Readonly<Record<string, unknown>>;
  readonly relevanceScore: number;
  readonly relevanceReason: string;
}

/**
 * The deterministic, explainable ranker. NO embedding/vector (the WORK-039
 * prompt: "A deterministic baseline-aware retrieval layer should be
 * established before optional semantic ranking"). The optional SemanticRanker
 * is a future slice; its output would remain ADVISORY evidence, not authority.
 *
 * Signals (each contributes a discrete weight + a reason fragment):
 *   * term_overlap        — work-item/freeform terms matched against matchText.
 *   * architecture_ref    — the item is referenced by an ArchitectureVersion.
 *   * requirement_ref     — the item is referenced by a Requirement/Criterion.
 *   * work_item_ref       — the item is referenced by a work item's scope.
 *   * dependency_ref      — the item is referenced by a dependency observation.
 *   * baseline_observation — the item IS a baseline observation (carries provenance).
 *   * test_relationship   — the item matches a test pattern.
 *   * repository_structure — the item is a structural element (directory/module).
 */
export interface ContextRanker {
  rank(query: ContextIndexQuery, candidates: readonly ContextSourceItem[]): Promise<readonly RankedContextItem[]>;
}

// ---------------------------------------------------------------------------
// The governed host inspector (OPTIONAL — the no-fabrication boundary).
// ---------------------------------------------------------------------------

/**
 * A tool-derived host observation (e.g. a file listing, a symbol reference)
 * produced by a governed ToolRuntime.invoke() call. Carries the HONEST
 * toolInvocationId that produced it (NEVER fabricated).
 */
export interface HostInspectionObservation {
  readonly toolInvocationId: string;
  readonly kind: ContextItemKind;
  readonly locator: string;
  readonly matchText: string;
  readonly contentDigest: string | null;
  readonly redacted: boolean;
}

export interface HostInspectionResult {
  readonly observations: readonly HostInspectionObservation[];
  /** HONEST references to governed host-tool invocations (NEVER fabricated; '[]' when nothing was inspected). */
  readonly toolInvocationIds: readonly string[];
}

/**
 * The governed host inspector (OPTIONAL). When task-specific filesystem
 * inspection is required, this runs inside a WORK-035 Workspace (isolated
 * worktree at the baseline commit) + uses WORK-036 ToolRuntime.invoke() for
 * every tool call. The WORK-037 ToolPolicyGate is respected; denied
 * operations produce blocked observations (recorded honestly); no fabricated
 * toolInvocationId ever lands on the index.
 *
 * The default implementation (NoOpHostInspector) returns NO observations +
 * '[]' toolInvocationIds — the ranker works on baseline evidence only. The
 * capability NEVER claims an operation was tool-governed when it was a
 * direct baseline read.
 */
export interface GovernedHostInspector {
  inspect(query: ContextIndexQuery, ctx: ContextResolutionContext): Promise<HostInspectionResult>;
}

// ---------------------------------------------------------------------------
// The resolution context (the read-only authority handles + the baseline).
// ---------------------------------------------------------------------------

export interface ContextResolutionContext {
  readonly organizationId: string;
  readonly projectGithubRepositoryId: string;
  readonly baselineCommitSha: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly installationId: string;
  readonly projectBaselineRepository: ProjectBaselineRepository;
  readonly projectContextIndexRepository: ProjectContextIndexRepository;
  readonly projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository;
  readonly githubAdapter: GitHubAdapter;
  readonly architectureVersionRepository: ArchitectureVersionRepository;
  readonly architectureRepository: ArchitectureRepository;
  readonly requirementRepository: RequirementRepository;
  readonly acceptanceCriterionRepository: AcceptanceCriterionRepository;
  readonly workItemRepository: WorkItemRepository;
  readonly workItemRequirementRepository: WorkItemRequirementRepository;
  readonly workItemCriterionRepository: WorkItemCriterionRepository;
}

// ---------------------------------------------------------------------------
// The result shapes (buildIndex / retrieve / detectStale).
// ---------------------------------------------------------------------------

export interface ContextSelection {
  readonly index: ProjectContextIndex;
  readonly items: readonly ContextItem[];
  /** The overall explanation: why this index was selected/returned (not a per-item reason). */
  readonly reason: string;
  /** Whether the index was freshly built by this call (false = existing index returned). */
  readonly freshlyBuilt: boolean;
}

export interface StaleReport {
  readonly index: ProjectContextIndex;
  /** The baseline's pinned commit (immutable per index). */
  readonly baselineCommitSha: string;
  /** The current repo HEAD (resolved through /github at report time; NULL if unresolvable). */
  readonly currentHeadSha: string | null;
  /** True iff the baseline's commit is no longer the current repo HEAD. */
  readonly stale: boolean;
}

export type BuildIndexResult =
  | { kind: 'complete'; index: ProjectContextIndex }
  | { kind: 'cas-lost'; index: ProjectContextIndex }
  | { kind: 'failed'; index: ProjectContextIndex; failureStage: string };

// ---------------------------------------------------------------------------
// The orchestrator interface.
// ---------------------------------------------------------------------------

export interface RepositoryIntelligenceService {
  /**
   * Build (or re-use) the context index for a baseline+query. Idempotent per
   * (baseline, query_kind, query_ref) — a re-build of the same baseline+query
   * returns the SAME row (no duplicate). If the index is already 'complete',
   * returns it (no rebuild). If 'indexing' (a concurrent job is running), the
   * caller observes the existing row (convergence — the loser reconciles).
   */
  buildIndex(query: ContextIndexQuery, ctx: ContextResolutionContext): Promise<BuildIndexResult>;

  /**
   * Retrieve the context selection for a baseline+query. If a 'complete'
   * index exists, returns it. If none exists, builds one. If an 'indexing'
   * row exists, the caller observes convergence (returns the existing row;
   * a subsequent retrieve re-reads once the indexing completes). NEVER
   * silently swaps the baseline under the caller (the index is pinned to
   * the caller's baselineId + its baseline_commit_sha).
   */
  retrieve(query: ContextIndexQuery, ctx: ContextResolutionContext): Promise<ContextSelection>;

  /**
   * Detect whether the index's baseline_commit_sha is still the current
   * repo HEAD. Returns a StaleReport (advisory; the index is NEVER swapped).
   */
  detectStale(query: ContextIndexQuery, ctx: ContextResolutionContext): Promise<StaleReport>;
}

// ---------------------------------------------------------------------------
// The capability's dependencies (the orchestrator's constructor input).
// ---------------------------------------------------------------------------

export interface RepositoryIntelligenceServiceDeps {
  readonly ranker: ContextRanker;
  readonly source: ContextSource;
  /** OPTIONAL — defaults to NoOpHostInspector (no host inspection; '[]' toolInvocationIds; no fabrication). */
  readonly hostInspector?: GovernedHostInspector;
  readonly logger: Logger;
}

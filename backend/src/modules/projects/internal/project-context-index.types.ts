/**
 * WORK-039: Repository and Context Intelligence — the context-index domain
 * types (the revision-bound, explainable, provenance-preserving context layer
 * that consumes WORK-038 Project Baselines + the existing /architecture,
 * /requirements, /work-items, /github, /agents authorities).
 *
 * The context index is a PROJECT artifact (PROJ-001 scope), stored THROUGH
 * the existing /projects authority (the same precedent as ProjectBaseline in
 * WORK-038). It is NOT:
 *   * a second project engine
 *   * a second repository / GitHub authority (it REFERENCES the existing
 *     wfos_project_github_repositories row + the existing ProjectBaseline row)
 *   * a second architecture authority (architecture observations in the index
 *     are REFERENCES to ArchitectureVersion ids, never duplicate architecture)
 *   * a second requirements authority (requirement items are REFERENCES to
 *     authoritative Requirement rows, never duplicate requirements)
 *   * a second workflow / verification / review authority
 *
 * REPOSITORY REVISION IS FUNDAMENTAL. A context index is ALWAYS pinned to a
 * concrete baseline_commit_sha. Context from commit A is NEVER silently
 * presented as context from commit B. The capability surfaces an explicit
 * stale advisory; it never swaps the baseline under the caller.
 *
 * PROVENANCE PRESERVATION (the central WORK-039 invariant). Every context
 * item carries the SAME provenance vocabulary as WORK-038 (observed |
 * inferred | confirmed | proposed). The ranker's relevance_score is ADVISORY
 * ONLY — ranking NEVER promotes provenance (observed+high stays observed;
 * inferred+high stays inferred; the ONLY path to 'confirmed' is the
 * authorized confirmation route on the baseline observation).
 *
 * EXPLAINABLE RELEVANCE. Every item carries a non-empty relevance_reason —
 * a human-readable chain of the deterministic signals that selected it. No
 * opaque AI-generated context.
 *
 * NO FABRICATED TOOL EVIDENCE. When governed host inspection runs (optional,
 * via Workspace + ToolRuntime), the real toolInvocationIds are recorded on
 * the index row. When no host inspection runs, tool_invocation_ids is '[]'
 * (NEVER a fake ID).
 *
 * TENANT ISOLATION. Every row is project_id + organization_id scoped. A UUID
 * is NEVER a credential (the route layer resolves + authorizes + accesses).
 *
 * SECURITY / REDACTION. The capability operates on already-redacted baseline
 * evidence/observations (WORK-038 redaction). The redacted flag is preserved
 * on context items; no reversal of redaction is possible.
 */
import type { BaselineProvenance } from './project-baseline.types.js';

// ---------------------------------------------------------------------------
// State + query shape (mirrors the WORK-038 baseline state machine).
// ---------------------------------------------------------------------------

export type ContextIndexState = 'indexing' | 'complete' | 'failed' | 'stale';

export type ContextIndexQueryKind =
  | 'work_item'
  | 'architecture'
  | 'requirement'
  | 'freeform';

/**
 * WHAT the context item IS (the SOURCE-FACT pointer — never the fact itself).
 * The kind + source + locator together form the idempotency key.
 */
export type ContextItemKind =
  | 'file'
  | 'directory'
  | 'module'
  | 'configuration'
  | 'test'
  | 'ci_workflow'
  | 'documentation'
  | 'architecture_observation'
  | 'requirement'
  | 'dependency_observation'
  | 'baseline_observation';

/**
 * WHERE the item came FROM (the authority reference; never the authority
 * itself — the capability never duplicates architecture/requirements/etc).
 */
export type ContextItemSource =
  | 'baseline_evidence'
  | 'baseline_observation'
  | 'architecture'
  | 'requirement'
  | 'work_item'
  | 'dependency_graph'
  | 'repository_structure'
  | 'tool_observation';

/**
 * The provenance vocabulary (re-uses the WORK-038 BaselineProvenance — never
 * a new vocabulary; the capability never collapses provenance into a
 * confidence number + never silently promotes it).
 */
export type ContextItemProvenance = BaselineProvenance;

// ---------------------------------------------------------------------------
// The index header (one row per project + baseline + query).
// ---------------------------------------------------------------------------

export interface ProjectContextIndex {
  readonly id: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly projectGithubRepositoryId: string;
  readonly baselineId: string;
  /** REPOSITORY REVISION IDENTITY — never silently swapped. */
  readonly baselineCommitSha: string;
  /** Deterministic identity: sha256 of the canonical item set (NULL until complete). */
  readonly contentDigest: string | null;
  readonly queryKind: ContextIndexQueryKind;
  /** The concrete authoritative ref (e.g. work_item_id; NULL for freeform). */
  readonly queryRef: string | null;
  /** The deterministic signal set the ranker consulted (opaque JSONB here; the capability types it). */
  readonly queryTermsJson: Readonly<Record<string, unknown>>;
  readonly state: ContextIndexState;
  readonly version: number;
  readonly indexingRunId: string | null;
  /** HONEST references to governed host-tool invocations (NEVER fabricated; '[]' when no host inspection ran). */
  readonly toolInvocationIds: readonly string[];
  readonly failureStage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finalizedAt: Date | null;
  readonly terminalAt: Date | null;
}

// ---------------------------------------------------------------------------
// The context item (one row per index + locator + source + kind).
// ---------------------------------------------------------------------------

export interface ContextItem {
  readonly id: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly contextIndexId: string;
  readonly baselineId: string;
  readonly kind: ContextItemKind;
  readonly locator: string;
  readonly source: ContextItemSource;
  /** PROVENANCE PRESERVATION — re-uses the WORK-038 vocabulary; the ranker never mutates this. */
  readonly provenance: ContextItemProvenance;
  /** sha256 of the item's canonical content (NULL for pure references). */
  readonly contentDigest: string | null;
  /** Redaction preserved from the underlying baseline evidence (NEVER reversed). */
  readonly redacted: boolean;
  /** ADVISORY relevance (deterministic, explainable, NEVER authority). */
  readonly relevanceScore: number;
  /** The explainable reason chain (NEVER empty). */
  readonly relevanceReason: string;
  /** HONEST references to baseline evidence rows (UUIDs; '[]' for pure authority references). */
  readonly evidenceRef: readonly string[];
  /** REFERENCES to authoritative domains (NEVER the authority itself). */
  readonly authorityRef: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

/**
 * The input shape for a new context item (the ranker produces these; the
 * repository inserts them idempotently).
 */
export interface NewContextItem {
  readonly kind: ContextItemKind;
  readonly locator: string;
  readonly source: ContextItemSource;
  readonly provenance: ContextItemProvenance;
  readonly contentDigest: string | null;
  readonly redacted: boolean;
  readonly relevanceScore: number;
  readonly relevanceReason: string;
  readonly evidenceRef: readonly string[];
  readonly authorityRef: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Repository inputs (the storage authority's interface).
// ---------------------------------------------------------------------------

export interface EnsureContextIndexInput {
  readonly projectId: string;
  readonly organizationId: string;
  readonly projectGithubRepositoryId: string;
  readonly baselineId: string;
  readonly baselineCommitSha: string;
  readonly queryKind: ContextIndexQueryKind;
  readonly queryRef: string | null;
  readonly queryTermsJson: Readonly<Record<string, unknown>>;
  readonly indexingRunId: string;
  /**
   * HONEST references to governed host-tool invocations (NEVER fabricated).
   * '[]' when no host inspection ran (the default). The repository NEVER
   * invents IDs here — it passes through exactly what the caller supplies.
   */
  readonly toolInvocationIds: readonly string[];
}

/**
 * The result of an idempotent ensureIndex. `created` = a new row was
 * inserted (the caller owns the indexing run + must drive the ranker +
 * markComplete/markFailed). `existing` = a row already exists for this
 * (baseline, query) — the caller reconciles (re-uses the existing items if
 * complete, or re-drives if the existing run is reclaimable).
 */
export type EnsureContextIndexResult =
  | { kind: 'created'; index: ProjectContextIndex }
  | { kind: 'existing'; index: ProjectContextIndex };

export interface MarkContextIndexCompleteInput {
  readonly indexId: string;
  readonly expectedVersion: number;
  readonly contentDigest: string;
  readonly items: readonly NewContextItem[];
}

export type MarkContextIndexCompleteResult =
  | { kind: 'complete'; index: ProjectContextIndex; items: readonly ContextItem[] }
  | { kind: 'cas-lost'; index: ProjectContextIndex };

export interface MarkContextIndexFailedInput {
  readonly indexId: string;
  readonly expectedVersion: number;
  readonly failureStage: string;
}

export interface MarkContextIndexStaleInput {
  readonly indexId: string;
  readonly expectedVersion: number;
}

// ---------------------------------------------------------------------------
// The storage authority's interface (implemented by the PG repository; the
// capability's orchestrator consumes it through this contract).
// ---------------------------------------------------------------------------

export interface ProjectContextIndexRepository {
  /**
   * Idempotent lookup-or-create on (baseline_id, query_kind, query_ref).
   * A re-index of the same baseline+query returns the SAME row.
   */
  ensureIndex(input: EnsureContextIndexInput): Promise<EnsureContextIndexResult>;

  /** Read a single index (the route's GET entry; ownership checked by the route). */
  findById(indexId: string): Promise<ProjectContextIndex | null>;

  /** Tenant-scoped lookup by (project, query_kind, query_ref) — non-terminal only. */
  findByQuery(
    projectId: string,
    queryKind: ContextIndexQueryKind,
    queryRef: string | null,
  ): Promise<ProjectContextIndex | null>;

  /** List indices for a baseline (the stale-detection surface). */
  listForBaseline(baselineId: string): Promise<readonly ProjectContextIndex[]>;

  /** List indices for a project (the project's context surface). */
  listForProject(projectId: string): Promise<readonly ProjectContextIndex[]>;

  /** Read the items of a complete index (the retrieval surface). */
  listItems(indexId: string): Promise<readonly ContextItem[]>;

  /**
   * CAS the index `indexing → complete` + idempotently upsert the items
   * inside a SINGLE transaction (atomic: either all items land + the index
   * completes, or nothing lands). The SELECT FOR UPDATE on the index row
   * (acquired inside the transaction) fences concurrent indexing jobs.
   */
  markComplete(input: MarkContextIndexCompleteInput): Promise<MarkContextIndexCompleteResult>;

  /** CAS the index `indexing → failed` (terminal; no items written). */
  markFailed(input: MarkContextIndexFailedInput): Promise<ProjectContextIndex>;

  /**
   * CAS the index `indexing → stale` (terminal). Used when the baseline's
   * commit is no longer the current repo HEAD but the caller wants to
   * preserve the old index for audit rather than delete it.
   */
  markStale(input: MarkContextIndexStaleInput): Promise<ProjectContextIndex>;

  /**
   * Reclaim a stale 'indexing' row whose run is no longer live (crash
   * recovery). Returns the reclaimed row (now owned by the new run) or null
   * if the row is no longer in 'indexing' state (another run won it).
   */
  reclaimStaleIndexing(
    indexId: string,
    newIndexingRunId: string,
    expectedVersion: number,
  ): Promise<ProjectContextIndex | null>;
}

// ---------------------------------------------------------------------------
// The typed error (the sanctioned discriminated-error-class exception —
// added to PURE_DATA_CATALOG_EXPORTS in static-architecture.test.ts).
// ---------------------------------------------------------------------------

export type RepositoryIntelligenceErrorCode =
  | 'context-index-not-found'
  | 'context-index-not-indexing'
  | 'context-index-terminal'
  | 'context-index-cas-lost'
  | 'context-index-baseline-not-complete'
  | 'context-index-no-items'
  | 'context-index-stale';

export const REPOSITORY_INTELLIGENCE_ERROR_CODES: readonly RepositoryIntelligenceErrorCode[] = [
  'context-index-not-found',
  'context-index-not-indexing',
  'context-index-terminal',
  'context-index-cas-lost',
  'context-index-baseline-not-complete',
  'context-index-no-items',
  'context-index-stale',
];

export class RepositoryIntelligenceError extends Error {
  readonly code: RepositoryIntelligenceErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  constructor(
    code: RepositoryIntelligenceErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RepositoryIntelligenceError';
    this.code = code;
    this.context = context;
  }
}

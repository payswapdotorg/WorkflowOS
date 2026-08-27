/**
 * WORK-051 — Architecture Governance and Checkpoints (public contract).
 *
 * The checkpoint capability is an APPLICATION-LAYER ORCHESTRATOR that lives
 * at `src/architecture-checkpoints/` (mirrors the §34 benchmark + WORK-033
 * execution-policy pattern: NOT an 18th frozen module — it CONSUMES the
 * frozen modules via their public barrels).
 *
 * Boundary contract (issue #51 + design
 * docs/superpowers/specs/2026-08-27-architecture-governance-checkpoints-design.md):
 *
 *   /architecture  owns ArchitectureVersions + the assertion set (read here
 *                  through the public barrel's ArchitectureAssertionReader).
 *   /verification  owns ALL durable evidence — checkpoint results are
 *                  persisted through the existing VerificationService
 *                  contract (NO parallel evidence store).
 *   /workflows     owns lifecycle state — the checkpoint NEVER mutates
 *                  workflow state; it returns a gating result the workflow
 *                  orchestrator consumes before performing the legal
 *                  transition.
 *   /reviews       remains the semantic architectural authority — mechanical
 *                  checkpoints reduce review burden, they do not replace
 *                  judgment.
 *
 * The subsystem imports from @modules/* (public barrels only — never
 * internal/) and @platform/*. It never issues SQL, never stores credentials,
 * and holds NO mutation-capable port over architecture, workflow, or
 * verification state (the reader ports below are structurally narrowed —
 * there is no method to call even if an implementation wanted to).
 */

import type {
  Architecture,
  ArchitectureVersion,
  ArchitectureAssertion,
  ArchitectureAssertionReader,
} from '@modules/architecture/index.js';
import type { WorkItem } from '@modules/work-items/index.js';
import type { VerificationService } from '@modules/verification/index.js';
import type {
  ArchitectureCheckpointKind,
  ArchitectureCheckpointGate,
  ArchitectureCheckpointGateInput,
  ArchitectureCheckpointGateResult,
} from '@modules/workflows/index.js';

export type {
  Architecture,
  ArchitectureVersion,
  ArchitectureAssertion,
  ArchitectureAssertionReader,
  WorkItem,
  VerificationService,
  ArchitectureCheckpointKind,
  ArchitectureCheckpointGate,
  ArchitectureCheckpointGateInput,
  ArchitectureCheckpointGateResult,
};

// ---------------------------------------------------------------------------
// Read-only reader ports (structurally narrowed — NO mutation capability)
// ---------------------------------------------------------------------------

/**
 * Read-only view of the ArchitectureVersion store. The composition root
 * satisfies this structurally from the /architecture repository; the port
 * deliberately exposes ONLY reads (no transitionState — the checkpoint
 * subsystem cannot mutate architecture versions).
 */
export interface ArchitectureVersionReader {
  findById(id: string): Promise<ArchitectureVersion | null>;
}

/**
 * Read-only view of the Architecture store (no create — the checkpoint
 * subsystem cannot create or mutate architecture definitions).
 */
export interface ArchitectureReader {
  findById(id: string): Promise<Architecture | null>;
}

/**
 * Read-only view of the Work Item store (no update — the checkpoint
 * subsystem cannot mutate work items).
 */
export interface WorkItemReader {
  findById(id: string): Promise<WorkItem | null>;
}

// ---------------------------------------------------------------------------
// Revision-bound repository snapshots (PR #52 round 1, BLOCKER 1)
// ---------------------------------------------------------------------------

/** One entry of a snapshot directory listing at the bound revision. */
export interface SnapshotDirEntry {
  readonly name: string;
  readonly type: 'file' | 'dir';
}

/**
 * Typed failure at the snapshot read boundary. ALWAYS fail-closed: a detector
 * that cannot inspect its required input returns 'inconclusive', never a
 * vacuous pass.
 */
export class SnapshotReadError extends Error {
  readonly code = 'snapshot-read-failed';
  /** What kind of failure: an unreadable path, a missing scan root, or an inconsistent tree. */
  readonly reason: 'unreadable' | 'root-missing' | 'inconsistent';

  constructor(reason: SnapshotReadError['reason'], message: string) {
    super(message);
    this.name = 'SnapshotReadError';
    this.reason = reason;
  }
}

/**
 * An EXACT-REVISION, read-only view of a governed repository — the ONLY
 * source repository-backed detectors may read (PR #52 round 1, BLOCKER 1).
 *
 * The bytes returned by this interface are bound to `revision` and come from
 * the existing /github authority's exact-revision content reads
 * (getFileContent/listDir at the resolved ref). Detectors NEVER read the
 * current working tree: a checkpoint that claims to have evaluated revision A
 * evaluates the snapshot opened at revision A — mutating the checkout on disk
 * cannot change a bound result.
 *
 * Read semantics (fail closed):
 * - `readFile` → the file's content at the revision, or null when the path
 *   does not exist at that revision. A read FAILURE throws
 *   {@link SnapshotReadError}.
 * - `listDir` → the directory entries at the revision ([] when the directory
 *   does not exist). A read FAILURE throws {@link SnapshotReadError}.
 * - `dirExists` → parent-chain-verified existence. A read FAILURE throws.
 */
export interface RepositorySnapshot {
  /** The exact implementation revision this snapshot is bound to. */
  readonly revision: string;
  /** The repository coordinates ('owner/name') — server-resolved. */
  readonly repository: string;
  listDir(path: string): Promise<readonly SnapshotDirEntry[]>;
  readFile(path: string): Promise<string | null>;
  dirExists(path: string): Promise<boolean>;
}

/**
 * The snapshot source authority: opens the EXACT-revision snapshot for a
 * project's repository. Repository coordinates are resolved SERVER-SIDE from
 * the project's /github link — callers never supply them.
 *
 * Returns null when the project has no linked repository (fail closed: no
 * snapshot ⇒ repository-backed assertions evaluate inconclusive). Throws on
 * resolution failure.
 */
export interface RepositorySnapshotReader {
  openSnapshot(projectId: string, revision: string): Promise<RepositorySnapshot | null>;
}

// ---------------------------------------------------------------------------
// Impact profile (design §6)
// ---------------------------------------------------------------------------

/**
 * The derived architecture-impact profile of a Work Item. Impact controls
 * CHECKPOINT FREQUENCY ONLY — it never weakens the underlying architecture
 * rules (an assertion that runs always runs with its full severity).
 *
 * LOW:    documentation/local behavior            → PR checkpoint only
 * MEDIUM: module/internal/data changes           → pre-implementation + PR
 * HIGH:   authority/public-interface/workflow/
 *         execution/security/schema boundaries   → readiness + pre-
 *                                                   implementation + PR +
 *                                                   verification entry
 *
 * Derivation (PR #52 round 1, HIGH — protected impact): the Work Item's
 * GOVERNED, persistence-enforced MONOTONIC declaration
 * (`WorkItem.architectureImpact` — declared at creation, updatable only in
 * the STRICTENING direction by the migration-0054 trigger, invisible to the
 * mutable-metadata update contract). Mutable `WorkItem.metadata` is NOT a
 * governance input: changing it can never downgrade a HIGH-impact item into
 * a lighter checkpoint frequency. Unset (NULL) derives the FAIL-CLOSED
 * default 'high' (the strictest frequency — never weaker).
 */
export type ArchitectureImpactLevel = 'low' | 'medium' | 'high';

export const ARCHITECTURE_IMPACT_LEVELS: readonly ArchitectureImpactLevel[] = [
  'low',
  'medium',
  'high',
];

/**
 * The impact applicability matrix for the initial increment (design §11):
 * which checkpoint kinds apply at each impact level. Expressed as DATA so
 * the static architecture invariants can pin it.
 */
export const IMPACT_CHECKPOINT_MATRIX: Readonly<
  Record<ArchitectureCheckpointKind, readonly ArchitectureImpactLevel[]>
> = {
  readiness: ['high'],
  work_order: ['medium', 'high'],
  pr_conformance: ['low', 'medium', 'high'],
  verification_entry: ['high'],
};

// ---------------------------------------------------------------------------
// Checkpoint evaluation vocabulary (design §4.2, §7)
// ---------------------------------------------------------------------------

export type ArchitectureCheckpointStatus =
  | 'passed'
  | 'passed_with_advisories'
  | 'blocked'
  | 'inconclusive';

export type ArchitectureDetectorStatus = 'pass' | 'fail' | 'inconclusive' | 'not_applicable';

/** One assertion's evaluation at one checkpoint (deterministic order: assertionId). */
export interface AssertionEvaluation {
  /** The stable human-facing assertion identifier (e.g. 'ARCH-051-001'). */
  assertionId: string;
  /** The immutable assertion row id. */
  assertionRowId: string;
  severity: 'blocking' | 'advisory';
  detectorKind: string;
  status: ArchitectureDetectorStatus;
  summary: string;
  details: Record<string, unknown>;
}

/**
 * The full checkpoint result. Preserves the traceability chain (design §9):
 *
 *   ArchitectureVersion → WorkItem → implementation revision → assertion set
 *     → detector results → verification evidence → checkpoint result
 *
 * `checkpointId` is the /verification run id that carries the durable
 * evidence (one evidence row per assertion + one summary row).
 */
export interface ArchitectureCheckpointResult {
  checkpointKind: ArchitectureCheckpointKind;
  workItemId: string;
  architectureVersionId: string;
  implementationRevision: string | null;
  /** The derived impact profile that determined applicability. */
  impact: ArchitectureImpactLevel;
  /** Whether this checkpoint kind applies at the work item's impact level. */
  applicable: boolean;
  status: ArchitectureCheckpointStatus | null;
  /** Whether the gated lifecycle progression may proceed. */
  allowed: boolean;
  evaluations: AssertionEvaluation[];
  blockingFindings: string[];
  advisories: string[];
  /** The /verification run id carrying the durable evidence (null when not applicable). */
  checkpointId: string | null;
  /** Whether this evaluation replayed a previously recorded result (idempotency). */
  replayed: boolean;
  /** ISO-8601 timestamp of the evaluation. */
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Detector contract (design §7)
// ---------------------------------------------------------------------------

/** Everything a deterministic detector may know about one evaluation. */
export interface DetectorInput {
  assertion: ArchitectureAssertion;
  checkpointKind: ArchitectureCheckpointKind;
  /**
   * The EXACT-REVISION repository snapshot (PR #52 round 1, BLOCKER 1) — the
   * ONLY repository source a detector may read. Present for revision-bound
   * checkpoints whose snapshot opened successfully. Null at checkpoints with
   * no revision binding (readiness / work_order) — repository-backed
   * assertions are then 'not_applicable' (nothing is bound yet); they can
   * never silently read the current working tree instead.
   */
  snapshot: RepositorySnapshot | null;
  /** Server-resolved authoritative context (never caller-supplied identity). */
  context: {
    projectId: string;
    workItemId: string;
    architectureVersionId: string;
    implementationRevision: string | null;
    workOrderId: string | null;
  };
}

export interface DetectorResult {
  status: ArchitectureDetectorStatus;
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * A narrow, deterministic detector. Detectors:
 * - read the repository tree / existing public contracts;
 * - never create alternate domain truth;
 * - never persist anything (evidence is /verification's job);
 * - never hold credentials or provider coupling;
 * - are deterministic: the same tree + config ⇒ the same result.
 */
export interface ArchitectureAssertionDetector {
  readonly detectorKind: string;
  evaluate(input: DetectorInput): Promise<DetectorResult>;
}

// ---------------------------------------------------------------------------
// The checkpoint service port
// ---------------------------------------------------------------------------

/**
 * The application-layer checkpoint service. Implements the /workflows gate
 * contract structurally (the orchestrator consumes `evaluate`) and exposes
 * the richer `evaluateCheckpoint` for direct consumption.
 */
export interface ArchitectureCheckpointService extends ArchitectureCheckpointGate {
  /** The /workflows lifecycle-gate projection (allowed / applicable / reasons). */
  evaluate(input: ArchitectureCheckpointGateInput): Promise<ArchitectureCheckpointGateResult>;
  /** The full evaluation (with per-assertion detector results). */
  evaluateCheckpoint(
    input: ArchitectureCheckpointGateInput,
  ): Promise<ArchitectureCheckpointResult>;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the caller's expected project context does not match the
 * authoritative project resolved server-side (work item → architecture
 * version → architecture → project). Raised BEFORE any detector executes —
 * cross-tenant checkpoint access never runs a detector.
 */
export class CrossTenantCheckpointAccessError extends Error {
  readonly code = 'cross-tenant-checkpoint-access';

  constructor(expectedProjectId: string, resolvedProjectId: string, workItemId: string) {
    super(
      `checkpoint: work item ${workItemId} belongs to project ${resolvedProjectId}, ` +
        `not the caller's project ${expectedProjectId}`,
    );
    this.name = 'CrossTenantCheckpointAccessError';
  }
}

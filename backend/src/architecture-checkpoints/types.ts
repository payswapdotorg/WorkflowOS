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
 * Derivation: WorkItem.metadata.architectureImpact when explicitly one of
 * 'low' | 'medium' | 'high'; otherwise the FAIL-CLOSED default 'high' (the
 * strictest checkpoint frequency — never weaker).
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

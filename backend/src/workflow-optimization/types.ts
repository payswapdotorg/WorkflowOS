/**
 * V2-011 — Workflow Optimization: the public domain contracts.
 *
 * The domain lives at `src/workflow-optimization/` (application-layer pure
 * domain module, mirroring the workflow-ir / teaching-sessions /
 * reverse-teaching precedent — NOT a frozen module; no persistence, no
 * routes, no migration). It owns EXACTLY the Work Order V2-011 scope
 * (spec/architecture/v2/work-orders/V2-011.md):
 *
 *   - optimization ANALYSIS of one pinned WorkflowIrDocument: deterministic
 *     opportunity detection (API substitution where a stable API is
 *     preferable to UI automation; reuse of existing workflows for
 *     duplicated logic) with typed UNSAFE rejections;
 *   - OPTIMIZATION PROPOSALS with explicit rationale and full provenance
 *     (baseline pin + analysis identity + rules version + candidate digest);
 *   - deterministic COMPARISON criteria for correctness, latency, cost,
 *     reliability and maintenance — the task-surface equivalence proof over
 *     the two documents (cross-checked by the merged V2-003 negotiation),
 *     the frozen modeled rubric, and the empirical run-history comparison
 *     over REAL V2-005 run records (read-only — the declared implementation
 *     dependency);
 *   - creation of EXPLICIT CANDIDATE WorkflowVersions through a materializer
 *     PORT (satisfied in composition by the real V2-002 repository service
 *     — never a second workflow/version authority);
 *   - the human/owner APPROVAL GATE: a candidate version is only materialized
 *     after the owner's explicit approval; the module NEVER activates,
 *     installs, deploys or enables anything (activation is V2-002/V2-009's
 *     surface, untouched here).
 *
 * BOUNDARY CONTRACT (Work Order V2-011 + the architecture constitution):
 *
 *   - NOT workflow identity/version authority (V2-002): candidate versions
 *     are created THROUGH the materializer port backed by the merged
 *     repository in composition; this module never imports the repository
 *     and never mutates an existing WorkflowVersion (no silent mutation —
 *     proposed changes always materialize as NEW versions);
 *   - NOT canonical WorkflowIR (V2-003): the analysis/comparison consume the
 *     merged validator, semantic digest, serializer and negotiation
 *     (contract dependency — consumed, never redefined; the derived
 *     candidate is a NEW document composed through the merged builder
 *     semantics, validated fail-closed);
 *   - NOT run/evidence authority (V2-005): real run histories are consumed
 *     READ-ONLY (type-only import) for the empirical baseline-vs-optimized
 *     comparison — the declared implementation dependency; no run is ever
 *     created, commanded or interpreted as evidence by this module;
 *   - NOT computer-agent execution (V2-008): only the safe-action SENSITIVE
 *     capability classification is consumed (contract-level, read-only) as
 *     the unsafe-optimization rule — substituting a node whose declared
 *     requirements intersect the sensitive set is REJECTED (the computer-use
 *     runtime's per-capability grants and takeover boundaries must never be
 *     silently removed);
 *   - NOT scheduling/events (V2-009), teaching (V2-006/V2-010), marketplace
 *     or economics, and NOT automatic activation of optimized versions
 *     (constitution §19: no hidden autonomous engine — a human/owner
 *     approves before anything changes).
 */
import type {
  WorkflowIrDocument,
  WorkflowVersionUpdateDecision,
} from '../workflow-ir/index.js';
import type { WorkflowRunHistory } from '../workflow-runs/index.js';

// ============================================================================
// §0  Vocabularies (frozen)
// ============================================================================

/** The optimization opportunity kinds (Work Order V2-011 must-deliver). */
export const OPTIMIZATION_OPPORTUNITY_KINDS = [
  /** a stable API is preferable to UI automation for one agentic node. */
  'api_substitution',
  /** duplicated logic should reference one existing workflow version. */
  'workflow_reuse',
] as const;
export type OptimizationOpportunityKind = (typeof OPTIMIZATION_OPPORTUNITY_KINDS)[number];

/**
 * The frozen analysis + comparison rules identity. Every analysis and
 * comparison record carries it; changing any detection rule or rubric weight
 * requires a new version (proposals are verifiable against their rules).
 */
export const OPTIMIZATION_RULES_VERSION = 'workflowos-optimization-rules-v1';

/** The typed reasons an optimization is rejected as UNSAFE (fail-closed). */
export const UNSAFE_OPTIMIZATION_REASONS = [
  /** substituting a node whose requirements intersect V2-008's sensitive set. */
  'SENSITIVE_CAPABILITY_SUBSTITUTION',
  /** the candidate would remove or alter a human decision point. */
  'HUMAN_NODE_MODIFIED',
  /** the candidate's task surface diverges from the baseline's. */
  'TASK_SURFACE_DIVERGED',
  /** the derived candidate fails the merged V2-003 validation. */
  'CANDIDATE_IR_INVALID',
] as const;
export type UnsafeOptimizationReason = (typeof UNSAFE_OPTIMIZATION_REASONS)[number];

// ============================================================================
// §1  The deterministic comparison rubric (frozen, modeled)
// ============================================================================

/** Recursively freeze a JSON-shaped constant (vocabulary freeze at load). */
function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeValue((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * The frozen modeled rubric: deterministic scoring functions over DECLARED
 * facts only. These are MODELS (documented weights — honest about being
 * estimates), never measurements; the empirical layer
 * (`compareRunHistories`) grounds them with real V2-005 run facts.
 *
 *   - latency units per execution class: the agentic computer-use loop
 *     (observe → decide → act) is modeled 3x the direct API call;
 *   - cost units: the agent loop (tokens + compute + retries) is modeled 4x
 *     a deterministic call; human steps cost the platform 0;
 *   - failure weights: UI automation brittleness (selectors, timing,
 *     layout) is modeled 0.15 per agentic node vs 0.02 per API call;
 *   - maintenance: node count + duplicated logic (2x weight) + agentic
 *     nodes (opaque task strings are hard to maintain).
 */
export const OPTIMIZATION_RUBRIC = freezeValue({
  rulesVersion: OPTIMIZATION_RULES_VERSION,
  latencyUnitsPerExecutionClass: {
    deterministic_api: 1,
    agentic_computer_use: 3,
    human: 1,
    subworkflow: 1,
  },
  costUnitsPerExecutionClass: {
    deterministic_api: 1,
    agentic_computer_use: 4,
    human: 0,
    subworkflow: 1,
  },
  failureWeightPerExecutionClass: {
    deterministic_api: 0.02,
    agentic_computer_use: 0.15,
    human: 0.05,
    subworkflow: 0.03,
  },
  maintenanceWeights: {
    perNode: 1,
    perDuplicateNode: 2,
    perAgenticNode: 1,
  },
} as const);
export type OptimizationRubric = typeof OPTIMIZATION_RUBRIC;

// ============================================================================
// §2  The baseline pin (carried as DATA)
// ============================================================================

/**
 * The immutable baseline WorkflowVersion an optimization proposes against.
 * The semantic digest is V2-003's (computed through the merged barrel —
 * consumed, never redefined here) and pins the EXACT analyzed content.
 */
export interface BaselineVersionPin {
  readonly workflowId: string;
  readonly versionId: string;
  readonly semanticDigest: string;
}

// ============================================================================
// §3  The analysis (deterministic opportunity detection)
// ============================================================================

/** An API substitution opportunity (the stable API beats UI automation). */
export interface ApiSubstitutionOpportunity {
  readonly kind: 'api_substitution';
  /** the agentic_computer_use node that can become a deterministic API call. */
  readonly nodeId: string;
  /** the declared agentic task (verbatim — the rationale's evidence). */
  readonly declaredTask: string;
  /** the declared capability requirements (verbatim — the rationale's evidence). */
  readonly declaredRequirements: readonly string[];
  /**
   * The single API-stable ordinary requirement the candidate will call
   * (exactly one — the deterministic_api spec carries one capability, so a
   * multi-requirement node is never substitutable under rules-v1 without
   * dropping part of its execution contract).
   */
  readonly apiCapability: string;
  /** the fixed-template rationale (declared facts only — never invented). */
  readonly rationale: string;
}

/** A reuse opportunity for duplicated logic (reference one shared version). */
export interface WorkflowReuseOpportunity {
  readonly kind: 'workflow_reuse';
  /** the duplicated node group in canonical node-id order. */
  readonly nodeIds: readonly string[];
  /** the sites that become subworkflow references (all but the first). */
  readonly substitutionSiteNodeIds: readonly string[];
  /** the fixed-template rationale (declared facts only — never invented). */
  readonly rationale: string;
}

export type OptimizationOpportunity =
  | ApiSubstitutionOpportunity
  | WorkflowReuseOpportunity;

/** A structurally-detected opportunity REJECTED as unsafe (typed reason). */
export interface RejectedOpportunity {
  readonly kind: OptimizationOpportunityKind;
  readonly nodeIds: readonly string[];
  readonly reason: UnsafeOptimizationReason;
  /** the fixed-template rejection rationale (declared facts only). */
  readonly rationale: string;
}

/**
 * The deterministic optimization analysis of one WorkflowIrDocument. Pure
 * function output: same document → same analysisId, opportunities and
 * rejections (zero clock, zero randomness). The analyzed document is
 * embedded deep-frozen (the derivation input — provenance evidence).
 */
export interface OptimizationAnalysis {
  /** deterministic identity: sha-256 over (rules version + semantic digest + derivation). */
  readonly analysisId: string;
  readonly rulesVersion: string;
  /** the analyzed document (deep-frozen — the derivation input). */
  readonly document: WorkflowIrDocument;
  readonly opportunities: readonly OptimizationOpportunity[];
  readonly rejected: readonly RejectedOpportunity[];
}

// ============================================================================
// §4  The deterministic comparison criteria (Work Order must-deliver)
// ============================================================================

/** The per-criterion delta (negative = the candidate improves the signal). */
export interface CriterionDelta {
  readonly baseline: number;
  readonly candidate: number;
  /** candidate − baseline (deterministic, rubric-derived). */
  readonly delta: number;
}

/** The task-surface equivalence proof (CORRECTNESS — compared FIRST). */
export interface TaskSurfaceEquivalence {
  readonly equivalent: boolean;
  /** the first divergence (surface path + detail) when not equivalent; null otherwise. */
  readonly firstDivergence: string | null;
}

/** The maintainability breakdown (the rubric's declared-fact factors). */
export interface MaintenanceBreakdown {
  readonly nodeCount: number;
  readonly duplicateNodeCount: number;
  readonly agenticNodeCount: number;
  readonly score: number;
}

/**
 * The deterministic baseline-vs-candidate comparison over the two documents:
 * correctness FIRST (the task-surface equivalence proof + the merged V2-003
 * negotiation cross-check of the candidate's public-surface declaration),
 * then the frozen modeled rubric for latency, cost, reliability and
 * maintenance. Same inputs → same output, always.
 */
export interface VersionComparison {
  readonly rulesVersion: string;
  /** CORRECTNESS: the task surface (what the workflow does) is preserved. */
  readonly correctness: TaskSurfaceEquivalence;
  /** the merged V2-003 negotiation decision for the candidate (cross-check). */
  readonly negotiation: WorkflowVersionUpdateDecision;
  readonly latency: CriterionDelta;
  readonly cost: CriterionDelta;
  readonly reliability: CriterionDelta;
  readonly maintenance: CriterionDelta;
  readonly maintenanceBreakdown: {
    readonly baseline: MaintenanceBreakdown;
    readonly candidate: MaintenanceBreakdown;
  };
}

// ============================================================================
// §5  The empirical run comparison (REAL V2-005 records, read-only)
// ============================================================================

/** The deterministic empirical comparison of two REAL run histories. */
export interface RunComparison {
  /** CORRECTNESS FIRST: both runs completed with the same steps and statuses. */
  readonly correctness: {
    readonly baselineCompleted: boolean;
    readonly optimizedCompleted: boolean;
    readonly sameStepSet: boolean;
    readonly sameStepStatuses: boolean;
    readonly equivalent: boolean;
  };
  /** resource cost signals (deterministic counts from the real records). */
  readonly resourceCost: {
    readonly baselineInvocationCount: number;
    readonly optimizedInvocationCount: number;
    readonly invocationDelta: number;
  };
  /** maintainability signals (deterministic counts from the real records). */
  readonly maintainabilitySignals: {
    readonly baselineDistinctCapabilities: readonly string[];
    readonly optimizedDistinctCapabilities: readonly string[];
    readonly baselineStepCount: number;
    readonly optimizedStepCount: number;
  };
}

// ============================================================================
// §6  The proposal (explicit rationale + provenance + approval gate)
// ============================================================================

export const OPTIMIZATION_PROPOSAL_STATUSES = [
  'proposed',
  'approved',
  'rejected',
  'materialized',
] as const;
export type OptimizationProposalStatus = (typeof OPTIMIZATION_PROPOSAL_STATUSES)[number];

/** An existing workflow version referenced by a reuse substitution. */
export interface SubworkflowReuseTarget {
  readonly workflowId: string;
  readonly versionRef: string;
}

/** Full provenance: where the proposal came from, verifiably. */
export interface ProposalProvenance {
  /** the exact baseline WorkflowVersion (workflow + version + V2-003 digest). */
  readonly baseline: BaselineVersionPin;
  /** the deterministic analysis identity the proposal derives from. */
  readonly analysisId: string;
  readonly rulesVersion: string;
  readonly opportunityKind: OptimizationOpportunityKind;
  readonly opportunityNodeIds: readonly string[];
  /** the V2-003 semantic digest of the DERIVED candidate document. */
  readonly candidateDigest: string;
}

/** The owner's explicit decision (the human approval the gate requires). */
export interface OwnerDecision {
  readonly ownerId: string;
  readonly decidedAt: number;
  readonly note?: string;
}

/** The record of the materialized candidate WorkflowVersion. */
export interface MaterializationRecord {
  readonly workflowId: string;
  /** the NEW candidate WorkflowVersion id (never the baseline's). */
  readonly versionId: string;
  readonly materializedAt: number;
  readonly candidateDigest: string;
}

/**
 * One optimization proposal: the analyzed change to ONE baseline
 * WorkflowVersion, with explicit rationale, full provenance, the derived
 * candidate document (the proposed change — always materialized as a NEW
 * WorkflowVersion, never a mutation), the pre-materialization deterministic
 * comparison, and the owner-approval gate state. Deep-frozen on every read.
 */
export interface OptimizationProposal {
  readonly id: string;
  readonly kind: OptimizationOpportunityKind;
  /** the workflow owner — the only principal who may approve/materialize. */
  readonly ownerId: string;
  readonly provenance: ProposalProvenance;
  /** the nodes the proposed change touches (never human nodes). */
  readonly affectedNodeIds: readonly string[];
  /** the explicit rationale (fixed template over declared facts). */
  readonly rationale: string;
  /** the baseline document (deep-frozen — provenance + the guard's input). */
  readonly baselineDocument: WorkflowIrDocument;
  /** the derived candidate document (deep-frozen — never mutated). */
  readonly candidateDocument: WorkflowIrDocument;
  /** the reuse target for workflow_reuse proposals (required to materialize). */
  readonly reuseTarget: SubworkflowReuseTarget | null;
  /** the pre-materialization deterministic comparison (baseline vs candidate). */
  readonly comparison: VersionComparison;
  readonly status: OptimizationProposalStatus;
  readonly createdAt: number;
  readonly decision: OwnerDecision | null;
  readonly materialization: MaterializationRecord | null;
}

// ============================================================================
// §7  The materializer port (the ONLY version-creation path)
// ============================================================================

/** The minimal protocol descriptor the materializer port carries. */
export interface CandidateVersionProtocol {
  readonly irSchemaVersion: string;
}

export interface CandidateVersionMaterializerInput {
  readonly workflowId: string;
  /** the baseline version the candidate derives from. */
  readonly parentVersionId: string;
  /** the serialized candidate document (canonical JSON object). */
  readonly content: Record<string, unknown>;
  readonly protocol: CandidateVersionProtocol;
}

export interface CandidateVersionMaterializerResult {
  /** the NEW candidate WorkflowVersion id. */
  readonly versionId: string;
}

/**
 * The candidate-version materializer port: satisfied in composition by the
 * REAL V2-002 workflow-repository service (createVersion) — this module
 * never imports the repository and never becomes a second version
 * authority. The port is the declared "creation of explicit candidate
 * WorkflowVersions" boundary.
 */
export interface CandidateVersionMaterializer {
  createCandidateVersion(
    input: CandidateVersionMaterializerInput,
  ): Promise<CandidateVersionMaterializerResult>;
}

// ============================================================================
// §8  Service inputs
// ============================================================================

export interface CreateProposalInput {
  /** the workflow owner (the only principal who may approve/materialize). */
  readonly ownerId: string;
  readonly workflowId: string;
  readonly versionId: string;
  /** the baseline document (fetched read-only by the caller through V2-002). */
  readonly document: WorkflowIrDocument;
  /**
   * The opportunity to propose: the agentic node's id (api_substitution) or
   * any member node id of the duplicate group (workflow_reuse).
   */
  readonly opportunityNodeId: string;
  /** required for workflow_reuse proposals to be materializable. */
  readonly reuseTarget?: SubworkflowReuseTarget | null;
}

export interface ProposalActionInput {
  readonly proposalId: string;
  readonly ownerId: string;
  readonly note?: string;
}

export interface MaterializeProposalInput {
  readonly proposalId: string;
  readonly ownerId: string;
}

export interface MaterializeProposalResult {
  readonly proposal: OptimizationProposal;
  readonly materialization: MaterializationRecord;
}

export interface ListProposalsInput {
  readonly workflowId?: string;
}

// ============================================================================
// §9  The service contract, the store port and the injected sources
// ============================================================================

/**
 * The workflow-optimization service: deterministic analysis, proposal
 * generation with provenance, the owner approval gate, materialization of
 * explicit candidate WorkflowVersions through the port, and the two
 * deterministic comparison surfaces.
 */
export interface WorkflowOptimizationService {
  /** Deterministic analysis of one document (pure; same input → same output). */
  analyzeWorkflow(document: WorkflowIrDocument): OptimizationAnalysis;

  /**
   * Create a proposal from one analyzed opportunity: validates the document
   * (merged V2-003, fail-closed), re-runs the analysis, resolves the
   * opportunity, derives the candidate, compares baseline-vs-candidate and
   * rejects unsafe optimizations with typed errors.
   */
  createProposal(input: CreateProposalInput): OptimizationProposal;

  /** Read one proposal (deep-frozen). */
  getProposal(proposalId: string): OptimizationProposal;

  /** List proposals (stable creation order; optionally workflow-scoped). */
  listProposals(input?: ListProposalsInput): readonly OptimizationProposal[];

  /** The owner's explicit approval (proposed → approved; terminal-safe). */
  approveProposal(input: ProposalActionInput): OptimizationProposal;

  /** The owner's explicit rejection (proposed → rejected; terminal). */
  rejectProposal(input: ProposalActionInput): OptimizationProposal;

  /**
   * Materialize the approved proposal as a NEW candidate WorkflowVersion
   * through the materializer port. Requires status 'approved' (typed
   * APPROVAL_REQUIRED otherwise); re-verifies every unsafe-optimization
   * guard against the stored baseline + candidate before calling the port;
   * records the new version identity. NEVER activates anything.
   */
  materializeProposal(input: MaterializeProposalInput): Promise<MaterializeProposalResult>;

  /** The deterministic document comparison (pure; exposed for verification). */
  compareVersions(baseline: WorkflowIrDocument, candidate: WorkflowIrDocument): VersionComparison;

  /** The empirical run-history comparison (pure; real V2-005 records, read-only). */
  compareRunHistories(baseline: WorkflowRunHistory, optimized: WorkflowRunHistory): RunComparison;
}

/** The proposal store port (durable storage is a separately-owned later concern). */
export interface OptimizationProposalStore {
  put(proposal: OptimizationProposal): void;
  get(proposalId: string): OptimizationProposal | undefined;
  list(): readonly OptimizationProposal[];
}

/** Injected deterministic sources (identity + clock) + the ports. */
export interface WorkflowOptimizationServiceDeps {
  readonly idFactory: () => string;
  readonly clock: () => number;
  readonly store: OptimizationProposalStore;
  readonly materializer: CandidateVersionMaterializer;
}

// ============================================================================
// §10  The typed error surface (fail-closed rejections)
// ============================================================================

export const WORKFLOW_OPTIMIZATION_ERROR_CODES = [
  'PROPOSAL_NOT_FOUND',
  'PROPOSAL_ALREADY_DECIDED',
  'PROPOSAL_ALREADY_MATERIALIZED',
  'APPROVAL_REQUIRED',
  'PROPOSAL_NOT_APPROVED',
  'OWNER_MISMATCH',
  'OPPORTUNITY_NOT_FOUND',
  'UNSAFE_OPTIMIZATION',
  'REUSE_TARGET_REQUIRED',
  'REUSE_TARGET_INVALID',
  'IR_DOCUMENT_INVALID',
  'MATERIALIZER_FAILED',
  'OPTIMIZATION_INPUT_INVALID',
] as const;
export type WorkflowOptimizationErrorCode =
  (typeof WORKFLOW_OPTIMIZATION_ERROR_CODES)[number];

/** Typed, fail-closed error for workflow-optimization operations. */
export class WorkflowOptimizationError extends Error {
  readonly code: WorkflowOptimizationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: WorkflowOptimizationErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`workflow-optimization: ${code}: ${message}`);
    this.name = 'WorkflowOptimizationError';
    this.code = code;
    this.details = details;
  }
}

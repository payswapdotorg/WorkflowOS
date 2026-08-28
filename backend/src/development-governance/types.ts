/**
 * WORK-052 — Development Governance & Self-Hosting Control Plane (public contract).
 *
 * The control plane is an APPLICATION-LAYER capability at
 * `src/development-governance/` (the architecture-checkpoints pattern: NOT an
 * 18th frozen module — the frozen module set stays 17). It is a PURE CONSUMER
 * of repository-resident state (ADR-0001):
 *
 *   - it READS `spec/development-state/governance-model.json` +
 *     `program-state.json` (the canonical machine-readable development state);
 *   - it validates them FAIL-CLOSED through the ONE shared engine exported by
 *     the architecture-checkpoints barrel (ADR-0004 — the substrate and the
 *     control plane can never disagree about validity);
 *   - it holds NO mutation ports over architecture, work-items, workflows,
 *     verification, or reviews (structurally query-only);
 *   - it issues NO SQL, touches NO database, creates NO tables;
 *   - it introduces NO workflow states and NO second authority of any kind.
 *
 * The state types + the validation engine live in the architecture-checkpoints
 * subsystem (the `governance-manifest` detector's input contract, ADR-0006) and
 * are re-exported here for consumers of the control plane.
 */

import type {
  AssuranceProfile,
  ChangeSurfaceFlag,
  ProofClass,
  GovernanceCheckpointKind,
  WorkOrderStatus,
  FeedbackOrigin,
  ImpactLevel,
  CheckpointContract,
  SelfHostingBoundary,
  ControlLoopStage,
  AuthorityMapEntry,
  GovernanceModel,
  CoordinationRecord,
  CheckpointOutcomeRecord,
  WorkOrderRecord,
  HandoffRecord,
  DecisionRecord,
  ProgramState,
  GovernanceValidationResult,
  SelectionRule,
  AssuranceRequirements,
  EnforcementReference,
  MergeEvidence,
  WorkOrderSurfaces,
  DecisionKind,
} from '../architecture-checkpoints/index.js';

export type {
  AssuranceProfile,
  ChangeSurfaceFlag,
  ProofClass,
  GovernanceCheckpointKind,
  WorkOrderStatus,
  FeedbackOrigin,
  ImpactLevel,
  SelectionRule,
  AssuranceRequirements,
  EnforcementReference,
  CheckpointContract,
  SelfHostingBoundary,
  ControlLoopStage,
  AuthorityMapEntry,
  GovernanceModel,
  MergeEvidence,
  WorkOrderSurfaces,
  CoordinationRecord,
  CheckpointOutcomeRecord,
  WorkOrderRecord,
  HandoffRecord,
  DecisionKind,
  DecisionRecord,
  ProgramState,
  GovernanceValidationResult,
};

export {
  ASSURANCE_PROFILES,
  CHANGE_SURFACE_FLAGS,
  PROOF_CLASSES,
  GOVERNANCE_CHECKPOINT_KINDS,
  WORK_ORDER_STATUSES,
  FEEDBACK_ORIGINS,
  CONTROL_LOOP_STAGES,
  CORE_SELF_HOSTING_PROHIBITIONS,
  CODE_PINNED_PROFILE_MINIMUMS,
  CODE_PINNED_COMPLETION_RULE,
  CODE_PINNED_POST_MERGE_FINALIZATION,
  selectAssuranceProfile,
} from '../architecture-checkpoints/index.js';

// ---------------------------------------------------------------------------
// Control-plane views (query results)
// ---------------------------------------------------------------------------

/** The governing state view — control questions 1 and 6. */
export interface GoverningStateView {
  architectureVersion: string;
  architectureVersionState: string;
  evolution: string;
  governingDocuments: string[];
  activeDesignPackage: string;
  controlLoop: readonly ControlLoopStage[];
  selfHostingBoundary: SelfHostingBoundary;
  authorityMap: readonly AuthorityMapEntry[];
  parallelProtocolRules: readonly string[];
  feedbackOrigins: readonly FeedbackOrigin[];
  decisions: readonly DecisionRecord[];
}

/** One shared change surface reported by conflict detection. */
export interface SharedSurface {
  kind: 'modules' | 'appLayer' | 'migrations' | 'reservedMigrations' | 'specDocs' | 'sharedIntegrationSurfaces';
  value: string;
}

/** A pairwise conflict between two in-flight / candidate work orders. */
export interface PairwiseConflict {
  a: string;
  b: string;
  sharedSurfaces: readonly SharedSurface[];
  /** Both records carry coordination records referencing each other (documented merge order / reserved numbering). */
  coordinated: boolean;
}

/** One candidate's parallel-eligibility assessment. */
export interface ParallelCandidateAssessment {
  workOrderId: string;
  /** True when every declared dependency is complete (the frontier rule). */
  dependencyEligible: boolean;
  unsatisfiedDependencies: readonly string[];
  conflictsWith: ReadonlyArray<{
    workOrderId: string;
    /** The partner's status: in-flight partners are ACTIVE conflicts; pending/blocked partners are potential conflicts that matter only if both start. */
    partnerStatus: WorkOrderStatus;
    sharedSurfaces: readonly SharedSurface[];
    coordinated: boolean;
  }>;
}

/** The parallel-eligibility report — control question 4 (ADR-0003). */
export interface ParallelEligibilityReport {
  assessments: readonly ParallelCandidateAssessment[];
  pairwise: ReadonlyArray<{
    a: string;
    b: string;
    /** True only when the two share NO declared surface. */
    parallelSafe: boolean;
    sharedSurfaces: readonly SharedSurface[];
    coordinated: boolean;
  }>;
}

/** The deterministic assurance resolution — control question 5 (ADR-0002). */
export interface AssuranceResolution {
  workOrderId: string;
  profile: AssuranceProfile;
  selectedFromSurfaces: readonly ChangeSurfaceFlag[];
  requiredCheckpointKinds: readonly GovernanceCheckpointKind[];
  requiredProofClasses: readonly ProofClass[];
  requiredEvidence: readonly string[];
  architectReviewRecord: boolean;
  impactFloor: ImpactLevel;
  runtimeImpactBinding: ImpactLevel | null;
  /** Contracts applicable at this profile, with the proof depth each demands here. */
  applicableContracts: ReadonlyArray<{
    contractId: string;
    area: string;
    severity: 'blocking' | 'advisory';
    requiredProofClasses: readonly ProofClass[];
  }>;
}

/** The implementation frontier — control questions 2, 3 and 4. */
export interface FrontierView {
  inFlight: ReadonlyArray<{
    id: string;
    title: string;
    branch: string;
    pr: number | null;
    head: string | null;
    assuranceProfile: AssuranceProfile;
    coordinated: boolean;
    incompleteDependencies: readonly string[];
    conflicts: ReadonlyArray<{ with: string; sharedSurfaces: readonly SharedSurface[]; coordinated: boolean }>;
  }>;
  /** Pending items whose dependencies are ALL complete — implementable once the architect authorizes them. */
  dependencyEligible: ReadonlyArray<{ id: string; title: string; assuranceProfile: AssuranceProfile }>;
  blocked: ReadonlyArray<{ id: string; title: string; blockedBy: readonly string[] }>;
  complete: readonly string[];
}

/** The resumption view — control question 7 (crash/restart/resume). */
export interface ResumptionView {
  workOrderId: string;
  title: string;
  status: WorkOrderStatus;
  branch: string | null;
  pr: number | null;
  workOrderRef: string | null;
  dependencies: ReadonlyArray<{ id: string; title: string; status: WorkOrderStatus }>;
  assurance: AssuranceResolution;
  handoff: HandoffRecord;
  coordination: CoordinationRecord | null;
  checkpointOutcomes: readonly CheckpointOutcomeRecord[];
  parallelProtocolRules: readonly string[];
  governingDocuments: readonly string[];
  decisions: readonly DecisionRecord[];
}

// ---------------------------------------------------------------------------
// The control-plane service port
// ---------------------------------------------------------------------------

/**
 * The repository-resident development-governance control plane. Query-only by
 * construction: there is no method that mutates architecture, work-items,
 * workflows, verification, or reviews state — the protocol's writes happen on
 * git branches and become canonical through architect PR merges.
 */
export interface DevelopmentGovernanceService {
  getGoverningState(): GoverningStateView;
  listWorkOrders(filter?: { status?: WorkOrderStatus }): readonly WorkOrderRecord[];
  getWorkOrder(workOrderId: string): WorkOrderRecord;
  getFrontier(): FrontierView;
  evaluateParallelEligibility(candidateIds?: readonly string[]): ParallelEligibilityReport;
  resolveAssurance(workOrderId: string): AssuranceResolution;
  /** The applicable checkpoint contracts + required proof depth for a profile. */
  getCheckpointApplicability(profile: AssuranceProfile): ReadonlyArray<{
    contractId: string;
    area: string;
    severity: 'blocking' | 'advisory';
    requiredProofClasses: readonly ProofClass[];
  }>;
  resumeImplementation(workOrderId: string): ResumptionView;
  /**
   * The merged-finalization audit (§34.8; ADR-0007): binds the canonical
   * state to the repository's git merge history and reports every gap — a
   * merged Work Order that is not yet `complete` with matching `mergedAs`.
   * Without explicit evidence the history is read from the bound repository
   * root (fail closed when neither is available). Query-only.
   */
  verifyPostMergeFinalization(evidence?: MergeHistoryEvidence): PostMergeFinalizationReport;
}

/** Merge evidence as consumed by the finalization audit (§34.8). */
export type MergeHistoryEvidence = import('./internal/merged-finalization.js').MergeEvidence;

/** The post-merge finalization report — the completion protocol's audit result. */
export interface PostMergeFinalizationReport {
  /** Work orders bound to merge evidence in the audited history. */
  readonly merged: number;
  /** Of those, the ones finalized truthfully (complete + matching mergedAs). */
  readonly finalized: number;
  /** Finalization gaps — empty means the canonical state matches the merge history. */
  readonly gaps: readonly string[];
  /** Where the evidence came from (explicit vs the repository git history). */
  readonly evidenceSource: string;
}

// ---------------------------------------------------------------------------
// Typed errors (fail closed)
// ---------------------------------------------------------------------------

/** The repository-resident governance state failed validation — refuse to serve it. */
export class GovernanceStateValidationError extends Error {
  readonly code = 'governance-state-invalid';
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(
      `the repository-resident development-governance state is INVALID (${violations.length} violation(s)): ` +
        violations.slice(0, 5).join(' | ') +
        (violations.length > 5 ? ` (+${violations.length - 5} more)` : ''),
    );
    this.name = 'GovernanceStateValidationError';
    this.violations = violations;
  }
}

/** Thrown when querying a work order that the program state does not know. */
export class UnknownWorkOrderError extends Error {
  readonly code = 'unknown-work-order';

  constructor(workOrderId: string) {
    super(`development-governance: no work order "${workOrderId}" in the repository program state`);
    this.name = 'UnknownWorkOrderError';
  }
}

/** Thrown when resuming a work order that carries no handoff record. */
export class NoResumableStateError extends Error {
  readonly code = 'no-resumable-state';

  constructor(workOrderId: string) {
    super(
      `development-governance: work order "${workOrderId}" has no handoff record to resume from ` +
        '(the repository-resident state holds nothing about an interrupted implementation of it)',
    );
    this.name = 'NoResumableStateError';
  }
}

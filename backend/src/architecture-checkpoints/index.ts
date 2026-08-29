/**
 * WORK-051 — Architecture Governance and Checkpoints (public barrel).
 *
 * The architecture-checkpoints domain is an APPLICATION-LAYER ORCHESTRATOR
 * that lives at `src/architecture-checkpoints/` (mirrors the §34 benchmark +
 * WORK-033 execution-policy pattern: NOT an 18th frozen module — it CONSUMES
 * the frozen modules via their public barrels).
 *
 * Boundary contract (static-architecture checks enforce):
 *   - imports from @modules/* (public barrels only — never internal/)
 *   - imports from @platform/* (cross-cutting infrastructure)
 *   - NEVER issues SQL; checkpoint evidence is persisted ONLY through the
 *     /verification public contract (VerificationService)
 *   - NEVER mutates workflow state (no WorkflowEngine access at all)
 *   - NEVER mutates architecture definitions (read-only reader ports only)
 *   - NEVER stores credentials; detectors have no provider coupling
 *   - NO scheduler/cron/setInterval in the initial increment
 *
 * Authority model (issue #51; design §4, §8):
 *   /architecture  owns ArchitectureVersions + assertions
 *   /verification  owns all durable evidence
 *   /workflows     owns lifecycle state (consumes the gate result)
 *   /reviews       remains the semantic architectural judgment authority
 */
export type {
  ArchitectureVersionReader,
  ArchitectureReader,
  WorkItemReader,
  ArchitectureImpactLevel,
  ArchitectureCheckpointStatus,
  ArchitectureDetectorStatus,
  AssertionEvaluation,
  ArchitectureCheckpointResult,
  DetectorInput,
  DetectorResult,
  ArchitectureAssertionDetector,
  ArchitectureCheckpointService,
  SnapshotDirEntry,
  RepositorySnapshot,
  RepositorySnapshotReader,
} from './types.js';
export {
  ARCHITECTURE_IMPACT_LEVELS,
  IMPACT_CHECKPOINT_MATRIX,
  CrossTenantCheckpointAccessError,
  SnapshotReadError,
} from './types.js';

export { DefaultArchitectureCheckpointService } from './internal/default-checkpoint-service.js';
export type { DefaultArchitectureCheckpointServiceDeps } from './internal/default-checkpoint-service.js';
export { CHECKPOINT_RUN_SOURCE, deriveImpact } from './internal/default-checkpoint-service.js';
export {
  GithubRepositorySnapshot,
  GithubRepositorySnapshotProvider,
} from './internal/github-snapshot-provider.js';
export {
  createDefaultDetectorRegistry,
  INITIAL_DETECTOR_KINDS,
} from './internal/detector-registry.js';

// ---------------------------------------------------------------------------
// WORK-052 — the development-governance state contracts + the ONE fail-closed
// validation engine (§34; ADR-0001/0004). These live in this subsystem because
// they are the input contract of the `governance-manifest` detector
// (ADR-0006); the application-layer control plane (src/development-governance/)
// consumes them through THIS barrel so the substrate and the control plane can
// never disagree about what a valid governed state is.
// ---------------------------------------------------------------------------
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
  CLASSIFICATION_ORDER,
  selectAssuranceProfile,
  validateGovernanceState,
  AUTHORITATIVE_WORK_ORDER_DIR,
} from './internal/governance-validation.js';
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
  GovernanceFileReader,
  GovernanceDirLister,
  GovernanceValidationResult,
} from './internal/governance-validation.js';

/**
 * V2-011 — Workflow Optimization public barrel.
 *
 * The domain lives at `src/workflow-optimization/` (application-layer pure
 * domain module — the V2-006/V2-010 family precedent). It owns the
 * optimization analysis (API substitution + reuse detection with typed
 * unsafe rejections), optimization proposals with explicit rationale and
 * full provenance, the deterministic five-criteria comparison (correctness
 * first), the empirical run-history comparison (real V2-005 records,
 * read-only), the owner approval gate, and creation of explicit candidate
 * WorkflowVersions through the materializer port (backed by the real
 * V2-002 repository in composition).
 *
 * Boundaries (V2-011):
 *   - NO workflow/version authority (V2-002 — consumed only through the
 *     materializer port in composition);
 *   - NO run/evidence authority (V2-005 — run histories consumed read-only
 *     for the empirical comparison);
 *   - NO computer-agent execution (V2-008 — only the sensitive-capability
 *     classification is consumed as the unsafe-optimization rule);
 *   - NO WorkflowIR redefinition (V2-003 — validator/digest/serializer/
 *     negotiation consumed through the merged barrel);
 *   - NO scheduling/events (V2-009), teaching, marketplace;
 *   - NO automatic activation: a human/owner approves before anything
 *     changes, and activation/installation/deployment are never touched.
 */
export {
  // §0 vocabularies (frozen)
  OPTIMIZATION_OPPORTUNITY_KINDS,
  OPTIMIZATION_RULES_VERSION,
  UNSAFE_OPTIMIZATION_REASONS,
  OPTIMIZATION_RUBRIC,
  OPTIMIZATION_PROPOSAL_STATUSES,
  // §6 proposal lifecycle
  // §10 typed error surface
  WORKFLOW_OPTIMIZATION_ERROR_CODES,
  WorkflowOptimizationError,
} from './types.js';
export type {
  OptimizationOpportunityKind,
  UnsafeOptimizationReason,
  OptimizationRubric,
  BaselineVersionPin,
  ApiSubstitutionOpportunity,
  WorkflowReuseOpportunity,
  OptimizationOpportunity,
  RejectedOpportunity,
  OptimizationAnalysis,
  CriterionDelta,
  TaskSurfaceEquivalence,
  MaintenanceBreakdown,
  VersionComparison,
  RunComparison,
  OptimizationProposalStatus,
  SubworkflowReuseTarget,
  ProposalProvenance,
  OwnerDecision,
  MaterializationRecord,
  OptimizationProposal,
  CandidateVersionProtocol,
  CandidateVersionMaterializerInput,
  CandidateVersionMaterializerResult,
  CandidateVersionMaterializer,
  CreateProposalInput,
  ProposalActionInput,
  MaterializeProposalInput,
  MaterializeProposalResult,
  ListProposalsInput,
  WorkflowOptimizationService,
  OptimizationProposalStore,
  WorkflowOptimizationServiceDeps,
  WorkflowOptimizationErrorCode,
} from './types.js';

// The service (the proposal lifecycle: analysis → proposal with provenance
// + the unsafe guard → the owner approval gate → materialization through
// the port; never an activation).
export { DefaultWorkflowOptimizationService } from './internal/workflow-optimization-service.js';

// The reference store + deterministic source factories (the V2-006/V2-010
// family precedent; durable proposal persistence is a separately-owned
// later concern).
export {
  InMemoryOptimizationProposalStore,
  createSequentialIdFactory,
  createSteppingClock,
} from './internal/in-memory-store.js';

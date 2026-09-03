/**
 * V2-013 — Self-Hosted Workflow Library (public barrel).
 *
 * Owns (spec/architecture/v2/work-orders/V2-013.md): the first-party
 * WorkflowOS development workflow artifacts (the six frozen procedures as
 * ordinary WorkflowIR documents), their repository/version manifests,
 * self-hosting installation for development environments through the SAME
 * V2-002 installation authority, the safe self-hosting permission
 * boundary, safe first-party execution packaging (V2-015 proof-predicate
 * consumption where a step requires a VerifiedExecutionFact), typed
 * failed-workflow recovery plans, and deterministic evidence
 * reconstruction.
 *
 * Boundaries (V2-013): V2-003 stays the workflow-semantics authority
 * (artifacts authored through its public builder); V2-002 stays the
 * repository/version/install authority (a narrow structural port,
 * type-only); V2-005 stays the Run/evidence authority (type-only run
 * history, no runs created here); V2-008 stays the computer-agent
 * execution authority (never imported — packaging produces typed
 * preconditions); V2-015 stays the execution-proof composition authority
 * (admission consumed verbatim); V2-012 is an independent sibling
 * (nothing imported); the development-governance authority is consumed
 * read-only (the code-pinned core prohibitions are the anti-weakening
 * floor). NO routes, NO migrations, NO new dependencies; no wall clock,
 * randomness, or network.
 */

// §0/§1 vocabularies + artifacts (the frozen six, canonical kind order)
export {
  FIRST_PARTY_PROCEDURE_KINDS,
  FIRST_PARTY_ALLOWED_CAPABILITIES,
  GOVERNANCE_PROTECTED_SURFACES,
  SELF_HOSTING_BOUNDARY_FAILURE_CODES,
  SELF_HOSTING_PACKAGING_FAILURE_CODES,
  SELF_HOSTING_RECOVERY_FAILURE_CODES,
} from './types.js';
export type {
  FirstPartyProcedureKind,
  FirstPartyExecutionPolicy,
  FirstPartyWorkflowArtifact,
  SelfHostingBoundaryPolicyInput,
  SelfHostingBoundaryFailureCode,
  SelfHostingBoundaryFailure,
  SelfHostingBoundaryVerdict,
  FirstPartyInstallPort,
  FirstPartyProtocolDescriptor,
  InstallFirstPartyWorkflowsInput,
  FirstPartyWorkflowManifest,
  FirstPartyInstallOutcome,
  FirstPartyPinFacts,
  ProofStepEvidenceInput,
  PackageFirstPartyExecutionInput,
  SelfHostingPackagingFailureCode,
  SelfHostingPackagingFailure,
  SelfHostingExecutionPackage,
  SelfHostingPackagingResult,
  FailedRunFacts,
  FirstPartyTargetVersionFacts,
  SelfHostingRecoveryFailureCode,
  SelfHostingRecoveryFailure,
  FailedWorkflowRecoveryPlan,
  PlanFailedWorkflowRecoveryInput,
  ReconstructSelfHostingEvidenceInput,
  SelfHostingEvidenceRecord,
  SelfHostingEvidenceReconstruction,
} from './types.js';

// §8 consumed public data types (type-only re-exports — one composition surface)
export type {
  WorkflowIrDocument,
  WorkflowVersionSemanticDigest,
  WorkflowPrincipal,
  CreateWorkflowInput,
  CreateVersionInput,
  InstallVersionInput,
  WorkflowInstallationDetail,
  WorkflowRunHistory,
  WorkflowRunState,
  PredecessorEvidence,
  ProofCompositionTrustPolicy,
  ProofAdmissionResult,
  ProofAdmissionFailure,
  AttestationVerification,
} from './types.js';

// internal/first-party-artifacts: the six first-party development workflows
export { FIRST_PARTY_WORKFLOW_ARTIFACTS, artifactByKind } from './internal/first-party-artifacts.js';

// internal/boundary: the self-hosting permission boundary (typed, fail-closed)
export { evaluateSelfHostingBoundary, validateBoundaryModel } from './internal/boundary.js';

// internal/installer: self-hosting installation through the real V2-002 port
export { installFirstPartyWorkflows, publishFirstPartyVersion } from './internal/installer.js';

// internal/packaging: safe first-party execution packaging (V2-015 consumption)
export { packageFirstPartyExecution } from './internal/packaging.js';

// internal/recovery: typed failed-workflow recovery plans
export { planFailedWorkflowRecovery } from './internal/recovery.js';

// internal/evidence: deterministic evidence reconstruction
export { reconstructSelfHostingEvidence } from './internal/evidence.js';

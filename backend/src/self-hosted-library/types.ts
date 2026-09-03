/**
 * V2-013 — Self-Hosted Workflow Library: the public contracts.
 *
 * WORK ORDER: spec/architecture/v2/work-orders/V2-013.md
 * WAVE: W6 (sequential). Base: d97a92f8 (canonical main after V2-015).
 *
 * The domain lives at `src/self-hosted-library/` (application-layer pure
 * domain module — the V2-012/V2-015 family precedent). V2-013 owns
 * EXACTLY:
 *
 *   - the first-party WorkflowOS development workflow ARTIFACTS (the six
 *     frozen procedures as ordinary WorkflowIR documents — authored through
 *     the merged V2-003 public builder, never a second workflow model);
 *   - the repository/version MANIFESTS for those artifacts (the mapping
 *     procedure kind → the real V2-002 workflow/version/installation
 *     identities + the V2-003 semantic digest);
 *   - SELF-HOSTING INSTALLATION for development environments: the
 *     composition of the REAL V2-002 authority (create-or-converge +
 *     version-pinned install) — first-party workflows install through the
 *     SAME authority, protocol and pin semantics as third-party workflows;
 *   - the SAFE SELF-HOSTING PERMISSION BOUNDARY: the typed gate that keeps
 *     first-party workflows inside the governance boundary (fail-closed
 *     against a weakened/absent boundary model, the code-pinned core
 *     prohibitions, the merge gate, governance-protected repository
 *     surfaces, and the first-party capability allowlist);
 *   - SAFE FIRST-PARTY EXECUTION PACKAGING: the typed decision that a
 *     pinned first-party workflow may be dispatched for execution in a
 *     development environment — boundary verdict + pin proof + the
 *     V2-015-consumed proof predicates where a step requires a
 *     VerifiedExecutionFact (never a re-implementation: V2-015's admission
 *     result is carried verbatim);
 *   - typed FAILED-WORKFLOW RECOVERY plans (a failed run is never
 *     resurrected in place; the pin never moves silently) and deterministic
 *     EVIDENCE RECONSTRUCTION over manifests + installation facts + run
 *     history.
 *
 * BOUNDARY CONTRACT (load-bearing, pinned by
 * tests/architecture/self-hosted-library-boundary.test.ts):
 *
 *   - V2-003 remains the ONLY workflow-semantics authority (public barrel
 *     consumption; artifacts are ordinary WorkflowIR documents).
 *   - V2-002 remains the ONLY workflow/version/install authority: the
 *     install surface is a NARROW STRUCTURAL PORT (type-only consumption of
 *     the repository service's method shapes — the real service satisfies
 *     it in composition; this module never imports the service and never
 *     re-implements repository semantics).
 *   - V2-005 remains the Run/evidence authority (type-only run-history
 *     data shapes; NO runs are created, driven, or mutated here).
 *   - V2-008 remains the computer-agent execution authority (never
 *     imported — packaging produces typed precondition packages, never
 *     executes).
 *   - V2-015 remains the execution-proof composition authority: proof
 *     predicates are consumed through `evaluateProofAdmission` (the merged
 *     public barrel) and its typed failures are carried VERBATIM; V2-014
 *     stays the verification authority (types consumed through V2-015's
 *     re-exports only).
 *   - V2-012 (marketplace/collaboration/economics) is an independent
 *     sibling: nothing is imported (first-party/third-party equivalence is
 *     proven at composition over the shared V2-002 authority — IG-005's
 *     later gate).
 *   - The development-governance authority (WORK-051/052, the
 *     architecture-checkpoints substrate) is consumed READ-ONLY: the
 *     code-pinned core self-hosting prohibitions are the anti-weakening
 *     floor the boundary evaluation enforces (ADR-0004: a weakened
 *     boundary file is a validation failure, never a silent pass).
 *   - NO routes, NO migrations, NO new dependencies; no wall clock, no
 *     randomness, no network in the module source.
 *   - REGISTRY CONFORMANCE (V2-CTRL-003): V2-013 introduces NO new
 *     protocol-visible identifiers — every capability in every artifact is
 *     an existing canonical registry name; first-party workflows are
 *     ordinary WorkflowOS workflows on the universal protocol.
 */

import type { WorkflowIrDocument, WorkflowVersionSemanticDigest } from '../workflow-ir/index.js';
import type {
  CreateVersionInput,
  CreateVersionResult,
  CreateWorkflowInput,
  CreateWorkflowResult,
  InstallVersionInput,
  InstallVersionResult,
  WorkflowInstallationDetail,
  WorkflowPrincipal,
} from '../workflow-repository/index.js';
import type { WorkflowRunHistory, WorkflowRunState } from '../workflow-runs/index.js';
import type {
  PredecessorEvidence,
  ProofCompositionTrustPolicy,
  ProofAdmissionFailure,
} from '../execution-proof-graph/index.js';

// ============================================================================
// §0 The frozen procedure vocabulary (exactly the six the work order names)
// ============================================================================

/**
 * The first-party development procedure kinds — V2-013's own frozen
 * vocabulary (module-internal, NOT protocol-visible): implementation,
 * review, testing, release, maintenance, dogfooding.
 */
export const FIRST_PARTY_PROCEDURE_KINDS = [
  'implementation',
  'review',
  'testing',
  'release',
  'maintenance',
  'dogfooding',
] as const;
export type FirstPartyProcedureKind = (typeof FIRST_PARTY_PROCEDURE_KINDS)[number];

// ============================================================================
// §1 The first-party artifacts + their execution policy
// ============================================================================

/**
 * The V2-013 execution-policy overlay for ONE first-party workflow (the
 * WorkflowIR content stays ordinary V2-003 — this overlay is packaging
 * metadata the module owns):
 *
 *   - `proofRequiredSteps`: the step ids whose execution REQUIRES a
 *     verified predecessor execution fact (the work order's
 *     proof-consumption conformance — the packaging consumes V2-015's
 *     admission over supplied predecessor evidence for exactly these
 *     steps; a step not listed here requires no predicate).
 */
export interface FirstPartyExecutionPolicy {
  readonly proofRequiredSteps: readonly string[];
}

/** ONE first-party development workflow artifact (pure data). */
export interface FirstPartyWorkflowArtifact {
  /** The procedure kind (the manifest key; one artifact per kind). */
  readonly kind: FirstPartyProcedureKind;
  /** The repository slug the installer publishes under (stable, namespaced). */
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** The ordinary WorkflowIR document (authored through V2-003's builder). */
  readonly document: WorkflowIrDocument;
  readonly executionPolicy: FirstPartyExecutionPolicy;
}

// ============================================================================
// §2 The self-hosting permission boundary (typed, fail-closed)
// ============================================================================

/**
 * The governance boundary policy INPUT: the machine-readable
 * selfHostingBoundary from `spec/development-state/governance-model.json`
 * (READ-ONLY data — the governance authority owns it; V2-013 never
 * mutates it). The boundary evaluation FAILS CLOSED when this input is
 * absent, malformed, or weaker than the code-pinned core prohibitions.
 */
export interface SelfHostingBoundaryPolicyInput {
  readonly may: readonly string[];
  readonly mayNot: readonly string[];
  readonly coreProhibitions: readonly string[];
}

/**
 * The canonical registry capabilities a first-party development workflow
 * may declare (V2-013's frozen allowlist — every name is an existing
 * canonical registry identifier; the boundary battery pins both that and
 * the artifacts' conformance).
 *
 * Deliberately EXCLUDES `github.pull_request.merge` — the architect's
 * merge gate is the canonical MAY-NOT ("let a self-hosted worker merge its
 * own governing PR — PR review by the architect is the only merge gate").
 */
export const FIRST_PARTY_ALLOWED_CAPABILITIES: readonly string[] = [
  'filesystem.read',
  'filesystem.write',
  'github.repository.read',
  'github.pull_request.create',
  'workflow.execute',
  'workflow.observe',
];

/**
 * The repository path prefixes that are governance-authoritative: a
 * first-party workflow artifact may never bind a write (or declare a
 * task) targeting these surfaces — changes there flow only through the
 * architecture-change/governance authorities (the frozen MAY-NOTs).
 */
export const GOVERNANCE_PROTECTED_SURFACES: readonly string[] = [
  'spec/architecture',
  'spec/development-state/',
  'spec/work-orders/',
  'docs/adr/',
];

/** V2-013 boundary-level failure codes (typed, fail-closed, never boolean). */
export const SELF_HOSTING_BOUNDARY_FAILURE_CODES = [
  /** The supplied boundary model is absent/malformed/weakened (fail-closed). */
  'SELF_HOSTING_BOUNDARY_MODEL_INVALID',
  /** A declared capability claims the architect merge gate (MAY-NOT). */
  'SELF_HOSTING_MERGE_GATE_VIOLATION',
  /** A declared capability is outside the first-party allowlist. */
  'SELF_HOSTING_CAPABILITY_NOT_ALLOWED',
  /** A step binds a governance-protected repository surface (MAY-NOT). */
  'SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED',
] as const;
export type SelfHostingBoundaryFailureCode = (typeof SELF_HOSTING_BOUNDARY_FAILURE_CODES)[number];

/** A typed boundary failure (deterministic, machine-readable). */
export interface SelfHostingBoundaryFailure {
  readonly code: SelfHostingBoundaryFailureCode;
  readonly detail: string;
  /** The offending step (when structurally recoverable). */
  readonly stepId?: string;
  /** The offending capability/path (when structurally recoverable). */
  readonly offending?: string;
}

/** The typed boundary verdict for one document. */
export type SelfHostingBoundaryVerdict =
  | {
      readonly allowed: true;
      /** The governance boundary fingerprint this verdict was evaluated under. */
      readonly coreProhibitions: readonly string[];
      /** The capabilities the document declares (all allowlisted). */
      readonly declaredCapabilities: readonly string[];
    }
  | { readonly allowed: false; readonly failure: SelfHostingBoundaryFailure };

// ============================================================================
// §3 Self-hosting installation (the narrow structural port over V2-002)
// ============================================================================

/**
 * The install surface V2-013 composes — the REAL V2-002 authority's method
 * shapes, consumed type-only. `DefaultWorkflowRepositoryService` satisfies
 * this structurally; tests compose the real service (through the real
 * routes) against it. This module never imports the service and never
 * re-implements repository/version/install semantics.
 */
export interface FirstPartyInstallPort {
  createWorkflow(principal: WorkflowPrincipal, input: CreateWorkflowInput): Promise<CreateWorkflowResult>;
  createVersion(
    principal: WorkflowPrincipal,
    workflowId: string,
    input: CreateVersionInput,
  ): Promise<CreateVersionResult>;
  installVersion(principal: WorkflowPrincipal, input: InstallVersionInput): Promise<InstallVersionResult>;
  getInstallation(
    principal: WorkflowPrincipal,
    organizationId: string,
    installationId: string,
  ): Promise<WorkflowInstallationDetail>;
}

/** The version protocol descriptor for first-party publications. */
export interface FirstPartyProtocolDescriptor {
  readonly irSchemaVersion: string;
}

/** The installer input (the development environment tenant + the port). */
export interface InstallFirstPartyWorkflowsInput {
  readonly principal: WorkflowPrincipal;
  /** The development environment's tenant (installations pin HERE). */
  readonly organizationId: string;
  readonly port: FirstPartyInstallPort;
  readonly protocol: FirstPartyProtocolDescriptor;
}

// ============================================================================
// §4 The repository/version manifest
// ============================================================================

/**
 * The repository/version manifest entry for ONE first-party workflow: the
 * mapping procedure kind → the REAL identities (V2-002 workflow/version/
 * installation) + the V2-003 semantic digest. The manifest is V2-013's own
 * durable record (deterministic derivation; the evidence reconstruction
 * converges on it).
 */
export interface FirstPartyWorkflowManifest {
  readonly kind: FirstPartyProcedureKind;
  readonly slug: string;
  readonly workflowId: string;
  /** The pinned EXACT immutable version (never moves silently). */
  readonly versionId: string;
  readonly versionNumber: number;
  /** V2-002's content digest of the pinned version (immutability proof). */
  readonly contentDigest: string;
  /** V2-003's semantic digest of the artifact's WorkflowIR document (the authority's exact structured output). */
  readonly semanticDigest: WorkflowVersionSemanticDigest;
  /** The development environment's installation pin (V2-002's record). */
  readonly installationId: string;
}

/** The installer outcome (per-kind, canonical order; converged flags). */
export interface FirstPartyInstallOutcome {
  readonly manifests: readonly FirstPartyWorkflowManifest[];
  /** Per kind: whether the workflow/version/install record was created vs converged. */
  readonly created: Readonly<Record<FirstPartyProcedureKind, { workflow: boolean; installation: boolean }>>;
}

// ============================================================================
// §5 Safe first-party execution packaging (typed, fail-closed)
// ============================================================================

/**
 * The pin facts read back from the REAL V2-002 authority (the caller reads
 * the installation through the port/routes; packaging is pure and compares
 * these against the manifest).
 */
export interface FirstPartyPinFacts {
  readonly organizationId: string;
  readonly installationId: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
}

/** The predecessor evidence supply for ONE proof-required step. */
export interface ProofStepEvidenceInput {
  /** The proof-required step id (must exist in the artifact's policy). */
  readonly stepId: string;
  /**
   * The exact declared parent set for the step's admission predicate —
   * VALIDATED against the artifact's authoritative WorkflowIR predecessor
   * edges (the PR #160 Blocker-1 correction): every VERIFIED evidence fact
   * must attest a WorkflowIR-declared predecessor step of this step within
   * the manifest's pinned workflow scope, and every IR-declared predecessor
   * must be covered by an admitted parent. A valid attestation for an
   * unrelated execution (foreign step, absent step identity, or foreign
   * workflow identity) NEVER satisfies the predicate (fail-closed).
   */
  readonly declaredParents: readonly string[];
  /** The evidence supplied for those parents (V2-015 wrappers). */
  readonly predecessorEvidence: readonly PredecessorEvidence[];
  /** Optional explicit capability/authorization facts (V2-015 inputs). */
  readonly capabilityRequirement?: readonly string[];
  readonly capabilityFacts?: readonly { nodeId: string; possessedCapabilities: readonly string[] }[];
  readonly authorizationRequired?: boolean;
  readonly authorizationGrants?: readonly { nodeId: string; capability: string }[];
  readonly dependentCapability?: string;
}

/** The packaging input. */
export interface PackageFirstPartyExecutionInput {
  readonly artifact: FirstPartyWorkflowArtifact;
  readonly manifest: FirstPartyWorkflowManifest;
  /** The governance boundary policy (READ-ONLY; fail-closed when weakened). */
  readonly boundary: SelfHostingBoundaryPolicyInput;
  /** The pin facts read back from the real authority (drift detection). */
  readonly pinFacts: FirstPartyPinFacts;
  /** The execution scope the package is minted FOR (one real run). */
  readonly executionScope: {
    readonly runId: string;
  };
  /** The trust policy for the proof predicates (V2-015's input). */
  readonly trustPolicy: ProofCompositionTrustPolicy;
  /** The predecessor evidence per proof-required step. */
  readonly proofSteps: readonly ProofStepEvidenceInput[];
}

/** V2-013 packaging failure codes (typed, fail-closed, never boolean). */
export const SELF_HOSTING_PACKAGING_FAILURE_CODES = [
  /** The self-hosting permission boundary denied the document. */
  'SELF_HOSTING_BOUNDARY_DENIED',
  /** The boundary model itself is invalid (fail-closed). */
  'SELF_HOSTING_BOUNDARY_MODEL_INVALID',
  /** The installed pin no longer matches the manifest (silent move = fail-closed). */
  'SELF_HOSTING_PIN_DRIFT',
  /** The manifest does not correspond to the supplied artifact. */
  'SELF_HOSTING_MANIFEST_MISMATCH',
  /** A proof-required step has NO evidence supply. */
  'SELF_HOSTING_PROOF_STEP_UNSUPPLIED',
  /** A proof predicate was REJECTED (the V2-015 admission failure verbatim). */
  'SELF_HOSTING_PROOF_PREDICATE_REJECTED',
  /**
   * The predecessor evidence is NOT bound to the WorkflowIR's authoritative
   * predecessor edges (the PR #160 Blocker-1 correction): a verified fact
   * attests a non-predecessor step (or a foreign workflow identity / absent
   * step identity), or an IR-declared predecessor is not covered by an
   * admitted parent — a valid attestation for an unrelated execution never
   * satisfies a proof-required step.
   */
  'SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED',
] as const;
export type SelfHostingPackagingFailureCode = (typeof SELF_HOSTING_PACKAGING_FAILURE_CODES)[number];

/** A typed packaging failure. */
export interface SelfHostingPackagingFailure {
  readonly code: SelfHostingPackagingFailureCode;
  readonly detail: string;
  /** Only for boundary denials: the boundary failure (verbatim). */
  readonly boundaryFailure?: SelfHostingBoundaryFailure;
  /** Only for pin drift: the expected/actual pin identities. */
  readonly expected?: string;
  readonly actual?: string;
  /** Only for proof predicate rejections: the V2-015 admission failure (verbatim). */
  readonly admissionFailure?: ProofAdmissionFailure;
  /** Only for parent-binding violations: the offending step id or workflow identity. */
  readonly offending?: string;
  /** The proof-required step the failure concerns. */
  readonly stepId?: string;
}

/**
 * The safe execution package: the typed precondition package a development
 * environment dispatches through the REAL execution authorities (V2-008/
 * V2-009/V2-005 — external; this module never executes). Carries the pin
 * proof, the boundary fingerprint, and the ADMITTED proof predicates.
 */
export interface SelfHostingExecutionPackage {
  readonly kind: FirstPartyProcedureKind;
  readonly workflowId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly semanticDigest: WorkflowVersionSemanticDigest;
  readonly installationId: string;
  /** The run the package was minted for (the precondition binding). */
  readonly runId: string;
  /** The governance boundary fingerprint the packaging was evaluated under. */
  readonly boundaryCoreProhibitions: readonly string[];
  /** The admitted proof predicates (per proof-required step, V2-015 results). */
  readonly admittedProofSteps: readonly {
    readonly stepId: string;
    readonly satisfiedParents: readonly string[];
    readonly trustedAttesterKeyIds: readonly string[];
  }[];
}

export type SelfHostingPackagingResult =
  | { readonly packaged: true; readonly package: SelfHostingExecutionPackage }
  | { readonly packaged: false; readonly failure: SelfHostingPackagingFailure };

// ============================================================================
// §6 Failed-workflow recovery (typed plans; never in-place resurrection)
// ============================================================================

/** The failed-run facts (type-only data read from the V2-005 authority). */
export interface FailedRunFacts {
  readonly runId: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly state: WorkflowRunState;
}

/**
 * The authoritative target facts for an advance request — BOTH read back
 * from the REAL V2-002 authority:
 *
 *   - `version`: the narrow structural read-back of V2-002's immutable
 *     `WorkflowVersion` identity (id, workflowId, versionNumber,
 *     contentDigest). V2-002 versions are immutable published records —
 *     the authority read-back IS the existence and publication proof.
 *   - `installation`: the target's installation read-back (the
 *     `FirstPartyPinFacts` shape — V2-002's installation record with its
 *     pinned version resolved, read back through the REAL installation
 *     path's own read surface). An advance plan is minted ONLY when this
 *     installation exists in the SAME development environment (tenant) and
 *     its pinned (workflowId, versionId, versionNumber, contentDigest)
 *     EXACTLY matches the target version — a published-but-NOT-installed
 *     target is never an advance (the PR #160 residual Blocker-2
 *     correction: publication alone does not make a target
 *     transition-ready).
 *
 * Absent, malformed, or non-corresponding facts are fail-closed (a
 * synthetic or uninstalled target is never an advance — the PR #160
 * Blocker-2 correction).
 */
export interface FirstPartyTargetVersionFacts {
  readonly version: {
    /** The target version's repository identity (MUST equal the requested toVersionId). */
    readonly id: string;
    /** The workflow the target version belongs to (MUST equal the manifest's workflowId). */
    readonly workflowId: string;
    /** The per-workflow sequence number of the target version. */
    readonly versionNumber: number;
    /** V2-002's content digest of the target version (immutability proof). */
    readonly contentDigest: string;
  };
  /**
   * REQUIRED (the residual Blocker-2 correction): the V2-002 installation
   * read-back for the target pin — obtained by installing the target
   * version through the REAL installation path and reading the
   * installation back (the `FirstPartyPinFacts` shape: the installation
   * record's own organization/installation/pin identities). The runtime
   * re-validates fail-closed that this installation belongs to the same
   * development environment as the manifest's current pin and pins the
   * EXACT target version identity.
   */
  readonly installation: FirstPartyPinFacts;
}

/** V2-013 recovery failure codes (typed, fail-closed). */
export const SELF_HOSTING_RECOVERY_FAILURE_CODES = [
  /** Only a terminal FAILED run is recoverable (never in-progress). */
  'SELF_HOSTING_RUN_NOT_FAILED',
  /** The run belongs to a different workflow/version than the manifest. */
  'SELF_HOSTING_RUN_SCOPE_MISMATCH',
  /** The recovery advance is not an explicit, governance-legal transition. */
  'SELF_HOSTING_RECOVERY_ADVANCE_INVALID',
  /**
   * The advance target is NOT proven by authoritative version facts (the
   * PR #160 Blocker-2 correction): no well-formed version facts were
   * supplied, the facts do not bind the exact requested target, or the
   * target belongs to a different workflow — a synthetic target is never
   * an advance (fail-closed).
   */
  'SELF_HOSTING_RECOVERY_TARGET_UNPROVEN',
  /**
   * The advance target is NOT INSTALLED in the development environment (the
   * PR #160 residual Blocker-2 correction): no well-formed installation
   * read-back was supplied, the installation belongs to a different
   * environment/tenant, or the installation's pinned version identity does
   * not EXACTLY match the target version facts — a published-but-uninstalled
   * (or wrongly-pinned) target is never an advance; install the target pin
   * through the REAL V2-002 installation path first (fail-closed).
   */
  'SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED',
  /** The boundary denied the recovery (governance preserved). */
  'SELF_HOSTING_BOUNDARY_DENIED',
] as const;
export type SelfHostingRecoveryFailureCode = (typeof SELF_HOSTING_RECOVERY_FAILURE_CODES)[number];

/** A typed recovery failure. */
export interface SelfHostingRecoveryFailure {
  readonly code: SelfHostingRecoveryFailureCode;
  readonly detail: string;
}

/**
 * The typed recovery plan: the NEXT governed action for a failed first-
 * party run. The plan is DATA — this module never drives the run
 * lifecycle; the caller executes it through the real authorities.
 */
export type FailedWorkflowRecoveryPlan =
  | {
      /** Retry against the SAME pinned version (a NEW run; the pin NEVER moves). */
      readonly kind: 'retry_same_pin';
      readonly workflowId: string;
      readonly versionId: string;
      readonly installationId: string;
      readonly failedRunId: string;
    }
  | {
      /**
       * Advance to a NEW explicit version (a governed version transition:
       * publish + install the new pin FIRST; the failed run stays failed —
       * never resurrected, never redirected in place).
       */
      readonly kind: 'advance_version';
      readonly workflowId: string;
      readonly fromVersionId: string;
      readonly toVersionId: string;
      readonly failedRunId: string;
    }
  | { readonly kind: 'blocked'; readonly failure: SelfHostingRecoveryFailure };

/** The recovery decision input. */
export interface PlanFailedWorkflowRecoveryInput {
  readonly manifest: FirstPartyWorkflowManifest;
  readonly failedRun: FailedRunFacts;
  /** The current installation pin facts (the pin the retry would target). */
  readonly pinFacts: FirstPartyPinFacts;
  /** The boundary policy (recovery requires the boundary to hold). */
  readonly boundary: SelfHostingBoundaryPolicyInput;
  /** The artifact (boundary re-evaluated at recovery time). */
  readonly artifact: FirstPartyWorkflowArtifact;
  /**
   * The requested action: retry the same pin, or advance to an explicit new
   * version PROVEN by authoritative target facts read back from the REAL
   * V2-002 authority — BOTH the version record (existence/publication/
   * same-workflow proof) AND the target's installation read-back in this
   * development environment (fail-closed when absent/malformed/
   * non-corresponding — a synthetic or published-but-uninstalled target is
   * never an advance).
   */
  readonly request:
    | { readonly action: 'retry_same_pin' }
    | {
        readonly action: 'advance_version';
        readonly toVersionId: string;
        /**
         * REQUIRED: the authoritative target facts — the version read-back
         * AND the target installation read-back (the same-environment pin
         * proof; install the target through the REAL V2-002 path first).
         */
        readonly targetVersion: FirstPartyTargetVersionFacts;
      };
}

// ============================================================================
// §7 Evidence reconstruction (deterministic composition over real records)
// ============================================================================

/** The reconstruction input (read-only facts from the real authorities). */
export interface ReconstructSelfHostingEvidenceInput {
  readonly manifests: readonly FirstPartyWorkflowManifest[];
  /** The pin facts read back for each manifest's installation. */
  readonly pinFacts: readonly FirstPartyPinFacts[];
  /** The run histories (V2-005 type-only data shapes). */
  readonly runHistories: readonly WorkflowRunHistory[];
}

/**
 * The reconstructed evidence record for one first-party workflow: what is
 * installed (pin proof), what executed (runs pinned to the manifest's
 * version), and what proof predicates the executions consumed (attestation
 * bindings + rejections). Deterministic: the same inputs reconstruct the
 * identical record.
 */
export interface SelfHostingEvidenceRecord {
  readonly kind: FirstPartyProcedureKind;
  readonly workflowId: string;
  readonly versionId: string;
  /** true when the installation pin matches the manifest exactly. */
  readonly pinMatchesManifest: boolean;
  /** Runs attributed to this manifest's exact pinned version. */
  readonly runs: readonly {
    readonly runId: string;
    readonly state: WorkflowRunState;
    readonly installationId: string | null;
    readonly attestationBindings: number;
    readonly attestationRejections: number;
    readonly evidenceRecords: number;
  }[];
  /** Total runs across ALL versions of this workflow seen in the histories. */
  readonly totalRunsSeen: number;
}

/** The deterministic reconstruction result (canonical kind order). */
export interface SelfHostingEvidenceReconstruction {
  readonly records: readonly SelfHostingEvidenceRecord[];
  /** Runs whose version does not match ANY manifest pin (drift signal — reported, never invented). */
  readonly unpinnedRuns: readonly { readonly runId: string; readonly workflowId: string; readonly versionId: string }[];
}

// ============================================================================
// §8 Re-exports of CONSUMED public data types (composition surface)
// ============================================================================

/**
 * Re-exported CONSUMED contracts (type-only): the public types this module
 * composes. Re-exporting keeps V2-013's consumers importing from ONE
 * public barrel while the owning modules stay the authorities.
 */
export type {
  WorkflowIrDocument,
  WorkflowVersionSemanticDigest,
} from '../workflow-ir/index.js';
export type {
  WorkflowPrincipal,
  CreateWorkflowInput,
  CreateVersionInput,
  InstallVersionInput,
  WorkflowInstallationDetail,
} from '../workflow-repository/index.js';
export type {
  WorkflowRunHistory,
  WorkflowRunState,
} from '../workflow-runs/index.js';
export type {
  PredecessorEvidence,
  ProofCompositionTrustPolicy,
  ProofAdmissionResult,
  ProofAdmissionFailure,
  AttestationVerification,
} from '../execution-proof-graph/index.js';

/**
 * WORK-045 — Agent Roles (PUBLIC CONTRACT).
 *
 * The agent-roles domain is an APPLICATION-LAYER ROLE MODEL that lives at
 * `src/agent-roles/` (mirrors the §34 benchmark / execution-policy /
 * execution-routing pattern: NOT the 18th frozen module — it CONSUMES the
 * frozen modules' public vocabulary and adds NO new authority).
 *
 * WHAT THIS LAYER IS (Work Order WORK-045, §33.9):
 *   A provider-independent ROLE CONTRACT + a CLOSED initial catalog of
 *   reusable engineering roles. A role describes responsibility, required
 *   capabilities/constraints (DECLARATIVE — consumed by the EXISTING
 *   eligibility/policy boundaries), expected inputs/outputs, and lifecycle
 *   metadata. It never names or binds to a provider implementation.
 *
 * WHAT THIS LAYER IS NOT (the governing contracts, verbatim):
 *   - NOT the workflow-state authority            (/workflows stays)
 *   - NOT the execution/provider gateway authority (/agents stays)
 *   - NOT the eligibility/selection policy authority (/execution-policy stays)
 *   - NOT the routing authority                    (WORK-044 stays)
 *   - NOT multi-agent delegation                   (WORK-046)
 *   - NOT agent intelligence                       (WORK-047)
 *   - NOT an authorization, verification, review, GitHub, or credential
 *     authority — and NEVER a second evaluator of anything.
 *
 * THE FORWARD DEPENDENCY SLICE:
 *
 *   WORK-044 (routing) → WORK-045 Agent Roles → WORK-046 Delegation
 *        → WORK-047 Agent Intelligence
 *
 * DETERMINISM + SAFETY (structural, not conventional):
 *   - The catalog is STATIC + IMMUTABLE application data (deep-frozen at
 *     module load; validated fail-closed at build). No persistence, no
 *     migration, no tenant-scoped configuration — the Work Order's
 *     preferred bounded representation.
 *   - Resolution is by STABLE ROLE IDENTITY and is deterministic
 *     (independent of object iteration or database ordering — there is no
 *     database).
 *   - Role-required capabilities reuse the WORK-043 `CapabilityRequirement`
 *     vocabulary (imported from the execution-policy PUBLIC barrel) — they
 *     are DECLARATIVE REQUIREMENTS that the existing eligibility boundary
 *     evaluates at execution time. This layer never evaluates anything.
 *   - Native and external execution remain FIRST-CLASS and SYMMETRIC: every
 *     role declares both modes as advisory availability, and no role may
 *     declare a mode-selecting capability requirement.
 *   - Every role carries a content-derived REVISION digest: changing a role
 *     definition changes the revision, so a historical (identity, revision)
 *     reference can never be silently reinterpreted.
 */
import type { ExecutionMode } from '@modules/agents';
import type { CapabilityRequirement } from '../execution-policy/index.js';

// ============================================================================
// ROLE IDENTITY — the stable, closed identity model (W045-AC02/AC14)
// ============================================================================

/**
 * The stable role identities of the CLOSED initial catalog (Work Order
 * WORK-045, "Initial role catalog"). The identity model is the seam later
 * work (WORK-046 delegation, WORK-047 intelligence) builds on WITHOUT
 * changing it: new roles may be appended by the catalog owner in a later
 * work order, but the identity-resolution semantics never change.
 */
export type AgentRoleId =
  | 'architect'
  | 'planner'
  | 'implementer'
  | 'tester'
  | 'security-reviewer'
  | 'performance-reviewer'
  | 'ux-reviewer'
  | 'release-engineer';

/** The declared catalog order (deterministic list ordering — W045-AC03). */
export type AgentRoleCatalogOrder = readonly AgentRoleId[];

// ============================================================================
// DECLARATIVE REQUIREMENTS — consumed by EXISTING boundaries (W045-AC05)
// ============================================================================

/**
 * The advisory execution-context constraint kinds a role may declare. These
 * deliberately echo the §15 ExecutionTaskProfile axes — they are ADVISORY
 * INPUTS to the existing profile/eligibility machinery, never evaluated
 * here.
 */
export type AgentRoleConstraintKind =
  | 'architecture-sensitive'
  | 'security-sensitive'
  | 'human-intervention-permitted'
  | 'human-intervention-discouraged';

/** One declarative advisory constraint (description required — inspectable). */
export interface AgentRoleAdvisoryConstraint {
  readonly kind: AgentRoleConstraintKind;
  readonly description: string;
}

// ============================================================================
// ARTIFACT DESCRIPTORS — expected inputs / outputs (W045-AC01)
// ============================================================================

/** One expected input or output artifact of the role. */
export interface AgentRoleArtifactDescriptor {
  /** Stable artifact name (kebab-case; e.g. 'work-order'). */
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

// ============================================================================
// EXECUTION SEMANTICS — declarative, advisory, mode-NEUTRAL (W045-AC06)
// ============================================================================

/**
 * The role's execution-mode declaration. ADVISORY ONLY: it documents that
 * both native and external execution remain first-class for the role and
 * never dispatches, selects, or prefers a provider. The SYMMETRIC
 * ['native', 'external'] set is enforced by catalog validation — a
 * mode-selecting declaration is structurally impossible.
 */
export interface AgentRoleExecutionDeclaration {
  readonly supportedModes: readonly ExecutionMode[];
  /** Always 'advisory' in WORK-045 — pinned by validation + tests. */
  readonly semantics: 'advisory';
}

// ============================================================================
// LIFECYCLE — stable versioning (W045-AC10)
// ============================================================================

/**
 * The role lifecycle metadata. `revision` is a CONTENT-DERIVED digest
 * (deterministic SHA-256 over the canonical definition, excluding the
 * revision itself): any change to any definition field produces a different
 * revision, so a historical (identity, revision) reference can never be
 * silently reinterpreted — while the identity stays stable.
 */
export interface AgentRoleLifecycle {
  /** The stable contract version (bumped only on intentional contract changes). */
  readonly contractVersion: number;
  /** The content-derived revision digest (16 hex chars). */
  readonly revision: string;
  readonly status: 'stable';
}

// ============================================================================
// EXTENSION SEAM — forward compatibility for WORK-046/047 (W045-AC14)
// ============================================================================

/**
 * The STABLE extension point of the role contract. Reserved for later work:
 *   - `delegation`  — WORK-046 multi-agent delegation metadata
 *   - `intelligence` — WORK-047 agent-intelligence metadata
 * Both are EMPTY in WORK-045 (enforced by catalog validation): later systems
 * ADD data here WITHOUT changing the role identity model, the contract
 * shape, or the resolution semantics. Any extension data is covered by the
 * content-derived revision (a change is detectable; identity is not).
 */
export interface AgentRoleExtensions {
  readonly delegation: Readonly<Record<string, never>>;
  readonly intelligence: Readonly<Record<string, never>>;
}

// ============================================================================
// THE ROLE CONTRACT (W045-AC01)
// ============================================================================

/**
 * The provider-independent role contract. Every field is descriptive or
 * declarative — NONE binds to a provider, model, adapter, or SDK (pinned by
 * catalog validation + static architecture tests).
 */
export interface AgentRoleContract {
  /** The stable role identity (the resolution key — W045-AC03). */
  readonly identity: AgentRoleId;
  readonly displayName: string;
  readonly purpose: string;
  readonly responsibilities: readonly string[];
  /**
   * Declarative capability requirements in the WORK-043
   * `CapabilityRequirement` vocabulary. Consumed (evaluated) ONLY by the
   * existing execution-policy eligibility boundary at execution time —
   * never here (W045-AC05). Mode-selecting kinds ('native_api' /
   * 'external_ui') are structurally forbidden (W045-AC06).
   */
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  /** Advisory execution-context constraints (declarative; never evaluated here). */
  readonly advisoryConstraints: readonly AgentRoleAdvisoryConstraint[];
  readonly expectedInputs: readonly AgentRoleArtifactDescriptor[];
  readonly expectedOutputs: readonly AgentRoleArtifactDescriptor[];
  /** The mode-NEUTRAL, advisory execution declaration (W045-AC06). */
  readonly execution: AgentRoleExecutionDeclaration;
  /** The lifecycle metadata incl. the content-derived revision (W045-AC10). */
  readonly lifecycle: AgentRoleLifecycle;
  /** The forward-compatibility seam — EMPTY in WORK-045 (W045-AC14). */
  readonly extensions: AgentRoleExtensions;
}

// ============================================================================
// RESOLUTION OUTPUT — explainable (W045-AC13)
// ============================================================================

/**
 * The advisory-vs-authoritative declaration semantics, surfaced on EVERY
 * resolved role so a consumer can never mistake a declaration for an
 * evaluation or an authority claim.
 */
export interface AgentRoleDeclarationSemantics {
  readonly requiredCapabilities: 'declarative-requirement';
  readonly requiredCapabilitiesEvaluatedBy: 'execution-policy (WORK-043) at execution time';
  readonly advisoryConstraints: 'advisory';
  readonly supportedExecutionModes: 'advisory';
  readonly dispatchAuthority: 'none — the role layer never dispatches or selects';
  readonly versioning: 'contractVersion + content-derived revision';
}

/** The resolved role: the contract + the declaration semantics (W045-AC13). */
export interface AgentRoleResolution {
  readonly role: AgentRoleContract;
  readonly declarationSemantics: AgentRoleDeclarationSemantics;
}

// ============================================================================
// SERVICE CONTRACT — deterministic resolution (W045-AC03)
// ============================================================================

/**
 * WORK-045 — the agent-role catalog service. Pure, synchronous, and
 * context-free by design: resolution takes ONLY the stable role identity —
 * there is no tenant/project/organization input to leak or spoof
 * (W045-AC11), and the closed static catalog cannot be affected by any
 * caller (W045-AC03). Request-scoped EXPOSURE (the HTTP routes) authorizes
 * within the caller's project context; the catalog itself is global truth.
 */
export interface AgentRoleCatalogService {
  /**
   * Resolve ONE role by its stable identity. Deterministic: repeated calls
   * return the identical (deep-frozen) resolution. Unknown identity → null
   * (the caller maps it to a 404; there is no fallback role).
   */
  resolveRole(identity: string): AgentRoleResolution | null;
  /**
   * The full closed catalog in the DECLARED deterministic order (never
   * object-iteration or database ordering — W045-AC03).
   */
  listRoles(): readonly AgentRoleResolution[];
}

/**
 * V2-004 — Node + Capability Protocol: the public contracts.
 *
 * WORK ORDER: spec/architecture/v2/work-orders/V2-004.md
 * REGISTRY:   spec/architecture/v2/V2-CTRL-003-protocol-registry.md (+ .json)
 * CONSTITUTION: §5 (node and capability authority), §12 (locality is a
 * correctness constraint), §16 (per-capability consent boundaries), §19
 * (forbidden drift), §21 (separate dimensions).
 *
 * Boundary contract of this module (load-bearing, pinned by
 * tests/unit/node-capability/module-boundary.test.ts):
 *
 *   - Node identity, workload identity, capability possession,
 *     authorization, placement, policy, trust, health and verification are
 *     SEPARATE dimensions. This module owns node identity, capability
 *     advertisement/versioning, requirement matching, placement/locality/
 *     privacy constraints, node trust/health attributes and cross-host
 *     conformance fixtures. It does NOT own and never decides authorization
 *     (an explicit separate dimension), and it contains no
 *     execution-truth, proof, or assurance concepts.
 *   - Capability advertisement is never authorization (constitution §5).
 *     A match result answers capability / placement / trust / health
 *     eligibility ONLY; the API shape keeps authorization out by design.
 *   - Registration-channel authentication is a minimal nonce
 *     challenge-response over node-scoped key material (HMAC-SHA256). It
 *     authenticates a node's registration channel — nothing else.
 *   - Protocol-visible names come exclusively from V2-CTRL-003: canonical
 *     capability names and placement ids are mirrored (read-only) from the
 *     frozen registry; aliases are rejected, never mapped.
 *   - Host platform classes (`web`, `desktop`, `ios`, `android`, `cloud`)
 *     are the host classes the constitution itself names (§1, §4); they are
 *     classification values, not registry-governed identifiers.
 */

// ============================================================================
// Protocol version
// ============================================================================

/** The node+capability protocol version implemented by this module. */
export const NODE_CAPABILITY_PROTOCOL_VERSION = 1;

/** Protocol versions this module accepts at registration/matching. */
export const SUPPORTED_NODE_PROTOCOL_VERSIONS: readonly number[] = [NODE_CAPABILITY_PROTOCOL_VERSION];

// ============================================================================
// Node identity and platform classification
// ============================================================================

/**
 * Host platform classes (constitution §1/§4: web, desktop, iOS, Android and
 * cloud hosts). Platform differences appear ONLY through advertised
 * capabilities, attributes, and placement availability — never through
 * different protocol semantics (§4).
 */
export const NODE_PLATFORM_CLASSES = ['web', 'desktop', 'ios', 'android', 'cloud'] as const;
export type NodePlatformClass = (typeof NODE_PLATFORM_CLASSES)[number];

/** Coarse placement-relevant location class of a node. */
export const NODE_LOCATION_CLASSES = ['device', 'cloud'] as const;
export type NodeLocationClass = (typeof NODE_LOCATION_CLASSES)[number];

/** Derives the placement-relevant location class from a platform class. */
export function nodeLocationClassOf(platformClass: NodePlatformClass): NodeLocationClass {
  return platformClass === 'cloud' ? 'cloud' : 'device';
}

// ============================================================================
// Trust and health vocabulary (node registration scope)
// ============================================================================

/**
 * Administrative trust tier of a node identity. This is a node-registration
 * trust attribute ONLY — it is not capability possession, not authorization,
 * not cryptographic authenticity of execution, and not an assurance class.
 * The assurance vocabulary (e.g. hardware-backed evidence classes) belongs
 * to the execution-trust protocol Work Order and is deliberately absent
 * here.
 */
export const NODE_TRUST_TIERS = ['untrusted', 'provisional', 'trusted'] as const;
export type NodeTrustTier = (typeof NODE_TRUST_TIERS)[number];

/** Self-reported health status of a node (honest declaration). */
export const NODE_HEALTH_STATUSES = ['unhealthy', 'degraded', 'healthy'] as const;
export type NodeHealthStatus = (typeof NODE_HEALTH_STATUSES)[number];

// ============================================================================
// Capability advertisement
// ============================================================================

/** Availability of one advertised capability on a node. */
export const CAPABILITY_AVAILABILITIES = ['available', 'degraded', 'unavailable'] as const;
export type CapabilityAvailability = (typeof CAPABILITY_AVAILABILITIES)[number];

/**
 * One advertised capability. `name` MUST be a canonical registry capability
 * name (lowercase, dot-separated — V2-CTRL-003); non-canonical aliases are
 * rejected at registration and in requirements (fail-closed).
 */
export interface CapabilityAdvertisement {
  readonly name: string;
  /** Advertisement version of this capability on this node (integer ≥ 1). */
  readonly version: number;
  readonly availability: CapabilityAvailability;
}

/** A required capability in a requirement set (data consumed by matching). */
export interface CapabilityRequirement {
  readonly name: string;
  /** Minimum advertisement version that satisfies this requirement (≥ 1). */
  readonly minVersion?: number;
}

// ============================================================================
// Placement / locality / privacy (V2-CTRL-003 canonical placement ids)
// ============================================================================

/** Canonical placement identifiers (frozen in V2-CTRL-003). */
export const PLACEMENT_IDS = [
  'device_local',
  'device_preferred',
  'cloud_allowed',
  'cloud_preferred',
  'cloud_required',
  'any_supported_node',
] as const;
export type PlacementId = (typeof PLACEMENT_IDS)[number];

/**
 * Placement constraints that are CORRECTNESS constraints (constitution §12:
 * locality is a correctness constraint, not a performance hint). A fallback
 * chain declared under one of these would silently violate the constraint —
 * it is rejected (fail-closed) instead.
 */
export const HARD_LOCALITY_PLACEMENT_IDS: readonly PlacementId[] = ['device_local', 'cloud_required'];

/**
 * The placement constraint of a requirement set.
 *
 * Semantics (deterministic; a node satisfies a constraint entry iff its
 * location class is in the entry's satisfied classes):
 *
 *   device_local        → {device}      (hard: fallback forbidden)
 *   device_preferred    → {device}      (cloud admitted ONLY via an explicit
 *                                       fallbackOrder entry — never silently)
 *   cloud_allowed       → {device, cloud} (no preference between classes)
 *   cloud_preferred     → {cloud}       (device admitted ONLY via an explicit
 *                                       fallbackOrder entry — never silently)
 *   cloud_required      → {cloud}       (hard: fallback forbidden)
 *   any_supported_node  → {device, cloud}
 *
 * `required` is the primary constraint (placement chain position 0).
 * `fallbackOrder` is an explicit ordered chain of additional constraints:
 * a node that does not satisfy `required` is evaluated against the chain in
 * order and takes the FIRST satisfied entry at placementRank
 * `1 + index`. The satisfied entry is always reported
 * (`satisfiedPlacement`) — placement substitution is never silent.
 */
export interface PlacementConstraint {
  readonly required: PlacementId;
  readonly fallbackOrder?: readonly PlacementId[];
}

/**
 * Privacy/locality constraint (constitution §12/§16): when `localOnly` is
 * true, workflow data must not leave the device — cloud nodes are
 * ineligible regardless of the placement chain. This is a boolean
 * correctness constraint, not a registry-governed identifier.
 */
export interface PrivacyConstraint {
  readonly localOnly: boolean;
}

// ============================================================================
// Registration protocol
// ============================================================================

/** Attributes a node declares about itself at registration. */
export interface NodeDeclaredAttributes {
  /**
   * Whether this node can surface a human approval/decision surface for
   * human-execution steps. A declared node attribute — not a capability
   * name (no canonical `human.approve` capability exists in the registry).
   */
  readonly supportsHumanApproval: boolean;
  readonly health: NodeHealthStatus;
}

/**
 * The full registration payload. The whole payload is bound under the
 * registration MAC, so platform class, protocol version, capabilities and
 * attributes cannot be altered in transit.
 */
export interface NodeRegistrationPayload {
  readonly nodeKeyFingerprint: string;
  readonly platformClass: NodePlatformClass;
  readonly protocolVersion: number;
  readonly capabilities: readonly CapabilityAdvertisement[];
  readonly attributes: NodeDeclaredAttributes;
}

/** A single-use registration challenge issued to a node key. */
export interface RegistrationChallenge {
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** A registration request: payload + challenge nonce + MAC response. */
export interface NodeRegistrationRequest extends NodeRegistrationPayload {
  readonly challengeNonce: string;
  /** Hex HMAC-SHA256 response computed by the node over the payload. */
  readonly response: string;
}

/** An authenticated node session issued at registration. */
export interface NodeSession {
  readonly nodeId: string;
  readonly sessionToken: string;
  readonly serial: number;
  readonly registeredAt: number;
}

/** Liveness state after a heartbeat. */
export interface NodeLiveness {
  readonly nodeId: string;
  readonly lastHeartbeatAt: number;
  readonly leaseExpiresAt: number;
  readonly health: NodeHealthStatus;
}

// ============================================================================
// Node record (the registered node as the directory sees it)
// ============================================================================

export interface NodeRecord {
  readonly nodeId: string;
  readonly nodeKeyFingerprint: string;
  readonly platformClass: NodePlatformClass;
  readonly locationClass: NodeLocationClass;
  readonly protocolVersion: number;
  readonly capabilities: readonly CapabilityAdvertisement[];
  readonly attributes: NodeDeclaredAttributes;
  readonly trust: NodeTrustAttributes;
  readonly registeredAt: number;
  readonly lastHeartbeatAt: number | null;
}

/** Administrative trust attributes (set by the control plane, not the node). */
export interface NodeTrustAttributes {
  readonly trustTier: NodeTrustTier;
}

// ============================================================================
// Requirement set (data input to matching — NOT workflow IR)
// ============================================================================

/**
 * A capability/placement requirement set for one workflow step, consumed as
 * DATA by the matcher. The WorkflowIR (V2-003) maps into this contract; this
 * module never defines IR semantics.
 *
 * Eligibility is the conjunction (constitution §5):
 *   capability availability AND placement constraints AND node trust/health
 * (workflow policy and user/organization authorization are separate
 * dimensions decided elsewhere — deliberately not representable here).
 */
export interface NodeRequirementSet {
  /** Optional stable identifier (fixture/trace correlation). */
  readonly id?: string;
  /** Required capabilities — ALL must be satisfied (conjunction). */
  readonly capabilities: readonly CapabilityRequirement[];
  readonly placement: PlacementConstraint;
  readonly privacy?: PrivacyConstraint;
  /** Requires nodes that declare human-approval support. */
  readonly humanApprovalRequired?: boolean;
  readonly minTrustTier?: NodeTrustTier;
  /**
   * Minimum node health. Default (when absent): `degraded` — a node that
   * declares itself unhealthy is excluded unless the requirement explicitly
   * opts in.
   */
  readonly minNodeHealth?: NodeHealthStatus;
  /** Minimum node protocol version (fail-closed protocol gating). */
  readonly minProtocolVersion?: number;
}

// ============================================================================
// Eligibility evaluation (dimension-separated; authorization is absent)
// ============================================================================

/**
 * The eligibility dimensions this protocol owns. Authorization is NOT among
 * them: it is an explicit separate dimension (constitution §5) decided by
 * its owning authority, and the match-result shape structurally cannot
 * express it.
 */
export const ELIGIBILITY_DIMENSIONS = ['protocol', 'capability', 'placement', 'trust', 'health'] as const;
export type EligibilityDimension = (typeof ELIGIBILITY_DIMENSIONS)[number];

/** Stable machine-readable ineligibility reason codes. */
export const NODE_ELIGIBILITY_REASON_CODES = [
  'PROTOCOL_VERSION_UNSUPPORTED',
  'CAPABILITY_NOT_ADVERTISED',
  'CAPABILITY_VERSION_BELOW_MINIMUM',
  'CAPABILITY_UNAVAILABLE',
  'PLACEMENT_CLASS_MISMATCH',
  'PLACEMENT_LOCALITY_VIOLATION',
  'PRIVACY_LOCAL_ONLY_VIOLATION',
  'HUMAN_APPROVAL_NOT_SUPPORTED',
  'TRUST_TIER_BELOW_MINIMUM',
  'HEARTBEAT_STALE',
  'HEALTH_BELOW_MINIMUM',
] as const;
export type NodeEligibilityReasonCode = (typeof NODE_ELIGIBILITY_REASON_CODES)[number];

/** One ineligibility reason, always dimension-tagged. */
export interface NodeEligibilityReason {
  readonly dimension: EligibilityDimension;
  readonly code: NodeEligibilityReasonCode;
  readonly detail: string;
}

/**
 * The eligibility evaluation of one node against one requirement set. Every
 * dimension is reported independently and honestly; `eligible` is the
 * conjunction of all five. A missing capability (or any other failure) is
 * an explicit ineligible result — never silent substitution, emulation, or
 * fallback.
 */
export interface NodeEligibilityEvaluation {
  readonly nodeId: string;
  readonly platformClass: NodePlatformClass;
  readonly locationClass: NodeLocationClass;
  readonly protocolEligible: boolean;
  readonly capabilityEligible: boolean;
  readonly placementEligible: boolean;
  readonly trustEligible: boolean;
  readonly healthEligible: boolean;
  readonly eligible: boolean;
  /** The placement chain entry the node actually satisfied, if any. */
  readonly satisfiedPlacement: PlacementId | null;
  /** 0 = primary constraint; 1+i = fallbackOrder entry i; null = ineligible. */
  readonly placementRank: number | null;
  readonly reasons: readonly NodeEligibilityReason[];
}

/** The result of matching a requirement set against the node directory. */
export interface NodeMatchResult {
  readonly evaluatedAt: number;
  /** Every evaluated node, ordered by nodeId (deterministic). */
  readonly evaluations: readonly NodeEligibilityEvaluation[];
  /**
   * Eligible nodes only, ordered by (placementRank, nodeId) — the
   * deterministic preference order implied by the placement chain.
   */
  readonly eligibleNodes: readonly NodeEligibilityEvaluation[];
}

// ============================================================================
// Ports (in-memory by default; adapters may back them durably later)
// ============================================================================

/** Out-of-band node key provisioning (the pre-shared node key material). */
export interface NodeKeyStore {
  /** Registers key material; returns the derived node key fingerprint. */
  enroll(nodeKeySecret: Uint8Array): { nodeKeyFingerprint: string };
  getSecret(nodeKeyFingerprint: string): Uint8Array | null;
}

/** Durable-style storage port for registered node records and sessions. */
export interface NodeRecordStore {
  saveRecord(record: NodeRecord): void;
  getRecord(nodeId: string): NodeRecord | null;
  /** All records in deterministic nodeId order. */
  listRecords(): readonly NodeRecord[];
  saveSession(nodeId: string, session: NodeSessionRecord): void;
  getSession(nodeId: string): NodeSessionRecord | null;
}

export interface NodeSessionRecord {
  /** Monotonic per-node registration serial (bumped on re-registration). */
  readonly serial: number;
  readonly token: string;
}

// ============================================================================
// The service contract
// ============================================================================

/**
 * The node+capability directory: authenticated node registration, capability
 * advertisement, heartbeat/liveness, administrative trust attributes, and
 * capability requirement matching (capability/placement/trust/health
 * eligibility ONLY — never authorization).
 */
export interface NodeCapabilityService {
  /** Provisions a node key out-of-band; returns its key fingerprint. */
  enrollNodeKey(input: { readonly nodeKeySecret: Uint8Array }): { readonly nodeKeyFingerprint: string };

  /** Issues a single-use registration challenge to an enrolled node key. */
  requestRegistrationChallenge(input: {
    readonly nodeKeyFingerprint: string;
  }): RegistrationChallenge;

  /**
   * Completes registration. Fail-closed on: unenrolled key, missing/replayed
   * challenge, expired challenge, unsupported protocol version, unknown
   * platform class, non-canonical/duplicate/invalid capabilities, invalid
   * attributes, or a challenge response that does not authenticate the
   * exact payload. Re-registration invalidates the previous session.
   */
  completeRegistration(input: NodeRegistrationRequest): NodeSession;

  /** Refreshes liveness (and optionally self-reported health). */
  heartbeat(input: {
    readonly nodeId: string;
    readonly sessionToken: string;
    readonly health?: NodeHealthStatus;
  }): NodeLiveness;

  /**
   * Atomically replaces a node's capability advertisement (validated
   * first — a rejected update never mutates the current advertisement).
   */
  updateAdvertisement(input: {
    readonly nodeId: string;
    readonly sessionToken: string;
    readonly capabilities: readonly CapabilityAdvertisement[];
  }): NodeRecord;

  /**
   * Sets administrative trust attributes. Administrative plane: a node never
   * declares its own trust tier.
   */
  setNodeTrustAttributes(input: {
    readonly nodeId: string;
    readonly trustTier: NodeTrustTier;
  }): NodeRecord;

  getNode(nodeId: string): NodeRecord | null;
  listNodes(): readonly NodeRecord[];

  /**
   * Matches a requirement set against every registered node. Deterministic:
   * given the same store state and injected clock, the result (including
   * reason ordering and node ordering) is identical.
   */
  matchNodes(requirement: NodeRequirementSet): NodeMatchResult;
}

// ============================================================================
// Cross-host conformance fixtures (shared contract for host classes + IG-002)
// ============================================================================

/**
 * One host-class advertisement inside a conformance fixture: what a host of
 * a given platform class registers (capabilities, attributes, trust, liveness
 * age) through the real protocol path.
 */
export interface HostAdvertisementFixture {
  /** Stable fixture-local advertisement id (mapped to the derived node id). */
  readonly id: string;
  readonly platformClass: NodePlatformClass;
  readonly protocolVersion: number;
  readonly capabilities: readonly CapabilityAdvertisement[];
  readonly attributes: NodeDeclaredAttributes;
  readonly trustTier: NodeTrustTier;
  /** Heartbeat age (ms) at evaluation time; > lease TTL ⇒ honestly stale. */
  readonly heartbeatAgeMs: number;
}

/** The expected eligibility outcome for one fixture advertisement. */
export interface ExpectedNodeEligibility {
  readonly nodeAdvertisementId: string;
  readonly eligible: boolean;
  readonly protocolEligible: boolean;
  readonly capabilityEligible: boolean;
  readonly placementEligible: boolean;
  readonly trustEligible: boolean;
  readonly healthEligible: boolean;
  readonly placementRank: number | null;
  /** Expected reason codes (compared as a set). */
  readonly reasonCodes: readonly string[];
}

/**
 * A protocol conformance fixture: host-class advertisements + one
 * requirement set + expected eligibility outcomes. Exported so host
 * implementations and IG-002 can verify themselves against the SAME shared
 * conformance contract.
 */
export interface HostConformanceFixture {
  readonly id: string;
  readonly description: string;
  /** Deterministic key seed for deriving the fixture node identities. */
  readonly keySeed: string;
  /** Protocol versions the evaluating service must accept (default [1]). */
  readonly supportedProtocolVersions?: readonly number[];
  readonly advertisements: readonly HostAdvertisementFixture[];
  readonly requirementSet: NodeRequirementSet;
  readonly expectedOutcomes: readonly ExpectedNodeEligibility[];
  /**
   * Optional cross-surface equivalence pair: two advertisements of DIFFERENT
   * platform classes expected to resolve with identical dimension outcomes
   * (constitution §13: honest differences only where capabilities genuinely
   * differ).
   */
  readonly crossSurfaceEquivalence?: { readonly a: string; readonly b: string };
}

// ============================================================================
// Typed errors (stable machine-readable codes — never parse message strings)
// ============================================================================

export const NODE_CAPABILITY_ERROR_CODES = [
  'NODE_KEY_NOT_ENROLLED',
  'REGISTRATION_CHALLENGE_NOT_FOUND',
  'REGISTRATION_CHALLENGE_ALREADY_USED',
  'REGISTRATION_CHALLENGE_EXPIRED',
  'REGISTRATION_RESPONSE_INVALID',
  'NODE_PROTOCOL_VERSION_UNSUPPORTED',
  'PLATFORM_CLASS_INVALID',
  'CAPABILITY_NAME_NOT_CANONICAL',
  'CAPABILITY_DUPLICATE_IN_ADVERTISEMENT',
  'CAPABILITY_VERSION_INVALID',
  'CAPABILITY_AVAILABILITY_INVALID',
  'HEALTH_STATUS_INVALID',
  'TRUST_TIER_INVALID',
  'NODE_NOT_FOUND',
  'NODE_SESSION_INVALID',
  'REQUIREMENT_INVALID',
] as const;
export type NodeCapabilityErrorCode = (typeof NODE_CAPABILITY_ERROR_CODES)[number];

/** Typed node+capability protocol error (discriminated by `code`). */
export class NodeCapabilityError extends Error {
  readonly code: NodeCapabilityErrorCode;

  constructor(code: NodeCapabilityErrorCode, message: string) {
    super(`node-capability ${code}: ${message}`);
    this.name = 'NodeCapabilityError';
    this.code = code;
  }
}

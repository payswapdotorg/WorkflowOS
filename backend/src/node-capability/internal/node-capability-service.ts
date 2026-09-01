import {
  SUPPORTED_NODE_PROTOCOL_VERSIONS,
  nodeLocationClassOf,
  type CapabilityAdvertisement,
  type NodeCapabilityService,
  type NodeEligibilityEvaluation,
  type NodeEligibilityReason,
  type NodeHealthStatus,
  type NodeLiveness,
  type NodeMatchResult,
  type NodeRecord,
  type NodeRegistrationPayload,
  type NodeRegistrationRequest,
  type NodeRequirementSet,
  type NodeSession,
  type NodeTrustTier,
  type NodeKeyStore,
  type NodeRecordStore,
  type RegistrationChallenge,
  type PlacementId,
  NodeCapabilityError,
} from '../types.js';
import {
  isNodeHealthStatus,
  isNodePlatformClass,
  isNodeTrustTier,
  placementSatisfiedByLocationClass,
  validateCapabilityAdvertisements,
  validateCapabilityRequirements,
  validatePlacementConstraint,
} from './canonical-registry.js';
import { InMemoryNodeKeyStore, InMemoryNodeRecordStore, makeSequentialNonceSource } from './in-memory-node-store.js';
import {
  computeSessionToken,
  verifyRegistrationResponse,
} from './node-auth.js';

/**
 * V2-004 — the node+capability directory service.
 *
 * Matching answers capability / placement / trust / health eligibility ONLY
 * (constitution §5 conjunction, minus the dimensions owned elsewhere:
 * workflow policy and user/organization authorization are decided outside
 * this protocol — the result shape structurally cannot express them).
 * A missing capability, a violated locality constraint, a stale heartbeat,
 * a low trust tier, or an unsupported protocol version is an EXPLICIT
 * ineligible result with a dimension-tagged reason — never silent
 * substitution, emulation, or fallback.
 */

const DEFAULT_REGISTRATION_CHALLENGE_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_LEASE_TTL_MS = 60_000;

const TRUST_TIER_RANK: Readonly<Record<NodeTrustTier, number>> = {
  untrusted: 0,
  provisional: 1,
  trusted: 2,
};

const HEALTH_RANK: Readonly<Record<NodeHealthStatus, number>> = {
  unhealthy: 0,
  degraded: 1,
  healthy: 2,
};

/** Default minimum node health when a requirement does not declare one. */
const DEFAULT_MIN_NODE_HEALTH: NodeHealthStatus = 'degraded';

export interface DefaultNodeCapabilityServiceDeps {
  /** Injected clock (epoch ms) — required for deterministic behavior. */
  readonly clock: () => number;
  /** Challenge nonce source (default: deterministic sequential). */
  readonly nonceSource?: () => string;
  /** Node key provisioning store (default: in-memory). */
  readonly keyStore?: NodeKeyStore;
  /** Node record store (default: in-memory). */
  readonly nodeStore?: NodeRecordStore;
  readonly registrationChallengeTtlMs?: number;
  readonly heartbeatLeaseTtlMs?: number;
  /** Protocol versions accepted at registration/matching (default: [1]). */
  readonly supportedProtocolVersions?: readonly number[];
}

interface PendingChallenge {
  readonly nodeKeyFingerprint: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  used: boolean;
}

export class DefaultNodeCapabilityService implements NodeCapabilityService {
  private readonly clock: () => number;
  private readonly nonceSource: () => string;
  private readonly keyStore: NodeKeyStore;
  private readonly nodeStore: NodeRecordStore;
  private readonly registrationChallengeTtlMs: number;
  private readonly heartbeatLeaseTtlMs: number;
  private readonly supportedProtocolVersions: readonly number[];
  private readonly pendingChallenges = new Map<string, PendingChallenge>();

  constructor(deps: DefaultNodeCapabilityServiceDeps) {
    this.clock = deps.clock;
    this.nonceSource = deps.nonceSource ?? makeSequentialNonceSource();
    this.keyStore = deps.keyStore ?? new InMemoryNodeKeyStore();
    this.nodeStore = deps.nodeStore ?? new InMemoryNodeRecordStore();
    this.registrationChallengeTtlMs =
      deps.registrationChallengeTtlMs ?? DEFAULT_REGISTRATION_CHALLENGE_TTL_MS;
    this.heartbeatLeaseTtlMs = deps.heartbeatLeaseTtlMs ?? DEFAULT_HEARTBEAT_LEASE_TTL_MS;
    this.supportedProtocolVersions =
      deps.supportedProtocolVersions ?? SUPPORTED_NODE_PROTOCOL_VERSIONS;
  }

  enrollNodeKey(input: { readonly nodeKeySecret: Uint8Array }): { readonly nodeKeyFingerprint: string } {
    return this.keyStore.enroll(input.nodeKeySecret);
  }

  requestRegistrationChallenge(input: { readonly nodeKeyFingerprint: string }): RegistrationChallenge {
    if (this.keyStore.getSecret(input.nodeKeyFingerprint) === null) {
      throw new NodeCapabilityError(
        'NODE_KEY_NOT_ENROLLED',
        `node key ${input.nodeKeyFingerprint} is not enrolled (out-of-band key provisioning required before registration)`,
      );
    }
    const nonce = this.nonceSource();
    const issuedAt = this.clock();
    const expiresAt = issuedAt + this.registrationChallengeTtlMs;
    this.pendingChallenges.set(nonce, {
      nodeKeyFingerprint: input.nodeKeyFingerprint,
      issuedAt,
      expiresAt,
      used: false,
    });
    return { nonce, issuedAt, expiresAt };
  }

  completeRegistration(input: NodeRegistrationRequest): NodeSession {
    // 1. The node key must be enrolled (fail closed).
    const secret = this.keyStore.getSecret(input.nodeKeyFingerprint);
    if (secret === null) {
      throw new NodeCapabilityError(
        'NODE_KEY_NOT_ENROLLED',
        `node key ${input.nodeKeyFingerprint} is not enrolled`,
      );
    }

    // 2. The challenge must exist, belong to this node key, be unused and
    //    unexpired (single-use, injected clock).
    const challenge = this.pendingChallenges.get(input.challengeNonce);
    if (challenge === undefined || challenge.nodeKeyFingerprint !== input.nodeKeyFingerprint) {
      throw new NodeCapabilityError(
        'REGISTRATION_CHALLENGE_NOT_FOUND',
        `registration challenge ${input.challengeNonce} was not issued to node key ${input.nodeKeyFingerprint}`,
      );
    }
    if (challenge.used) {
      throw new NodeCapabilityError(
        'REGISTRATION_CHALLENGE_ALREADY_USED',
        `registration challenge ${input.challengeNonce} was already consumed (challenges are single-use)`,
      );
    }
    if (this.clock() > challenge.expiresAt) {
      throw new NodeCapabilityError(
        'REGISTRATION_CHALLENGE_EXPIRED',
        `registration challenge ${input.challengeNonce} expired at ${String(challenge.expiresAt)} (now ${String(this.clock())})`,
      );
    }

    // 3. The advertised protocol version must be supported (fail closed —
    //    never partially accept an unknown protocol).
    if (!this.supportedProtocolVersions.includes(input.protocolVersion)) {
      throw new NodeCapabilityError(
        'NODE_PROTOCOL_VERSION_UNSUPPORTED',
        `node protocol version ${String(input.protocolVersion)} is not supported (supported: ${this.supportedProtocolVersions.join(', ')})`,
      );
    }

    // 4. Platform class must be one of the five host classes.
    if (!isNodePlatformClass(input.platformClass)) {
      throw new NodeCapabilityError(
        'PLATFORM_CLASS_INVALID',
        `platform class "${String(input.platformClass)}" is not one of web, desktop, ios, android, cloud`,
      );
    }

    // 5. Capability advertisement must be registry-conformant.
    validateCapabilityAdvertisements(input.capabilities);

    // 6. Declared attributes must be valid.
    if (!isNodeHealthStatus(input.attributes.health)) {
      throw new NodeCapabilityError(
        'HEALTH_STATUS_INVALID',
        `declared health "${String(input.attributes.health)}" is not one of unhealthy, degraded, healthy`,
      );
    }

    // 7. The challenge response must authenticate the EXACT payload.
    const payload: NodeRegistrationPayload = {
      nodeKeyFingerprint: input.nodeKeyFingerprint,
      platformClass: input.platformClass,
      protocolVersion: input.protocolVersion,
      capabilities: input.capabilities,
      attributes: input.attributes,
    };
    if (
      !verifyRegistrationResponse({
        nodeKeySecret: secret,
        payload,
        nonce: input.challengeNonce,
        response: input.response,
      })
    ) {
      throw new NodeCapabilityError(
        'REGISTRATION_RESPONSE_INVALID',
        `registration response does not authenticate the payload for node key ${input.nodeKeyFingerprint} (challenge ${input.challengeNonce})`,
      );
    }

    // 8. Commit: burn the challenge, issue a fresh session, save the record.
    challenge.used = true;
    const nodeId = input.nodeKeyFingerprint;
    const registeredAt = this.clock();
    const serial = (this.nodeStore.getSession(nodeId)?.serial ?? 0) + 1;
    const sessionToken = computeSessionToken({
      nodeKeySecret: secret,
      nodeKeyFingerprint: nodeId,
      serial,
    });
    this.nodeStore.saveSession(nodeId, { serial, token: sessionToken });
    const existing = this.nodeStore.getRecord(nodeId);
    const record: NodeRecord = {
      nodeId,
      nodeKeyFingerprint: input.nodeKeyFingerprint,
      platformClass: input.platformClass,
      locationClass: nodeLocationClassOf(input.platformClass),
      protocolVersion: input.protocolVersion,
      capabilities: input.capabilities.map((c) => ({ ...c })),
      attributes: { ...input.attributes },
      // Registration itself counts as the initial liveness signal; a
      // re-registration refreshes it.
      trust: existing?.trust ?? { trustTier: 'untrusted' },
      registeredAt,
      lastHeartbeatAt: registeredAt,
    };
    this.nodeStore.saveRecord(record);
    return { nodeId, sessionToken, serial, registeredAt };
  }

  heartbeat(input: {
    readonly nodeId: string;
    readonly sessionToken: string;
    readonly health?: NodeHealthStatus;
  }): NodeLiveness {
    const record = this.requireRecord(input.nodeId);
    this.requireValidSession(record, input.sessionToken);
    if (input.health !== undefined && !isNodeHealthStatus(input.health)) {
      throw new NodeCapabilityError(
        'HEALTH_STATUS_INVALID',
        `heartbeat health "${String(input.health)}" is not one of unhealthy, degraded, healthy`,
      );
    }
    const lastHeartbeatAt = this.clock();
    const updated: NodeRecord = {
      ...record,
      attributes: { ...record.attributes, health: input.health ?? record.attributes.health },
      lastHeartbeatAt,
    };
    this.nodeStore.saveRecord(updated);
    return {
      nodeId: updated.nodeId,
      lastHeartbeatAt,
      leaseExpiresAt: lastHeartbeatAt + this.heartbeatLeaseTtlMs,
      health: updated.attributes.health,
    };
  }

  updateAdvertisement(input: {
    readonly nodeId: string;
    readonly sessionToken: string;
    readonly capabilities: readonly CapabilityAdvertisement[];
  }): NodeRecord {
    const record = this.requireRecord(input.nodeId);
    this.requireValidSession(record, input.sessionToken);
    // Validate BEFORE mutating: a rejected update never changes state.
    validateCapabilityAdvertisements(input.capabilities);
    const updated: NodeRecord = {
      ...record,
      capabilities: input.capabilities.map((c) => ({ ...c })),
    };
    this.nodeStore.saveRecord(updated);
    return { ...updated, capabilities: updated.capabilities.map((c) => ({ ...c })) };
  }

  setNodeTrustAttributes(input: {
    readonly nodeId: string;
    readonly trustTier: NodeTrustTier;
  }): NodeRecord {
    const record = this.requireRecord(input.nodeId);
    if (!isNodeTrustTier(input.trustTier)) {
      throw new NodeCapabilityError(
        'TRUST_TIER_INVALID',
        `trust tier "${String(input.trustTier)}" is not one of untrusted, provisional, trusted`,
      );
    }
    const updated: NodeRecord = { ...record, trust: { trustTier: input.trustTier } };
    this.nodeStore.saveRecord(updated);
    return { ...updated };
  }

  getNode(nodeId: string): NodeRecord | null {
    return this.nodeStore.getRecord(nodeId);
  }

  listNodes(): readonly NodeRecord[] {
    return this.nodeStore.listRecords();
  }

  matchNodes(requirement: NodeRequirementSet): NodeMatchResult {
    validateRequirementSet(requirement);
    const evaluatedAt = this.clock();
    const evaluations = this.nodeStore.listRecords().map((record) =>
      this.evaluateNode(record, requirement, evaluatedAt),
    );
    const eligibleNodes = evaluations
      .filter((evaluation) => evaluation.eligible)
      .sort((a, b) => {
        const rankA = a.placementRank ?? Number.MAX_SAFE_INTEGER;
        const rankB = b.placementRank ?? Number.MAX_SAFE_INTEGER;
        if (rankA !== rankB) return rankA - rankB;
        return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
      });
    return { evaluatedAt, evaluations, eligibleNodes };
  }

  // ------------------------------------------------------------------------
  // Per-node eligibility evaluation (dimension-separated)
  // ------------------------------------------------------------------------

  private evaluateNode(
    record: NodeRecord,
    requirement: NodeRequirementSet,
    now: number,
  ): NodeEligibilityEvaluation {
    const reasons: NodeEligibilityReason[] = [];

    // --- protocol dimension (fail closed) ---
    let protocolEligible = true;
    if (!this.supportedProtocolVersions.includes(record.protocolVersion)) {
      protocolEligible = false;
      reasons.push({
        dimension: 'protocol',
        code: 'PROTOCOL_VERSION_UNSUPPORTED',
        detail: `node advertises protocol version ${String(record.protocolVersion)} which this directory no longer accepts (supported: ${this.supportedProtocolVersions.join(', ')})`,
      });
    } else if (
      requirement.minProtocolVersion !== undefined &&
      record.protocolVersion < requirement.minProtocolVersion
    ) {
      protocolEligible = false;
      reasons.push({
        dimension: 'protocol',
        code: 'PROTOCOL_VERSION_UNSUPPORTED',
        detail: `node protocol version ${String(record.protocolVersion)} is below the required minimum ${String(requirement.minProtocolVersion)}`,
      });
    }

    // --- capability dimension (explicit ineligibility, never substitution) ---
    let capabilityEligible = true;
    for (const required of requirement.capabilities) {
      const advertised = record.capabilities.find((c) => c.name === required.name);
      if (advertised === undefined) {
        capabilityEligible = false;
        reasons.push({
          dimension: 'capability',
          code: 'CAPABILITY_NOT_ADVERTISED',
          detail: `required capability "${required.name}" is not advertised by node ${record.nodeId} (no substitution, emulation, or fallback)`,
        });
        continue;
      }
      const minVersion = required.minVersion ?? 1;
      if (advertised.version < minVersion) {
        capabilityEligible = false;
        reasons.push({
          dimension: 'capability',
          code: 'CAPABILITY_VERSION_BELOW_MINIMUM',
          detail: `capability "${required.name}" is advertised ${String(advertised.version)} but minimum ${String(minVersion)} is required`,
        });
        continue;
      }
      if (advertised.availability !== 'available') {
        capabilityEligible = false;
        reasons.push({
          dimension: 'capability',
          code: 'CAPABILITY_UNAVAILABLE',
          detail: `capability "${required.name}" is advertised but currently ${advertised.availability}`,
        });
      }
    }

    // --- placement dimension: chain, privacy, human approval ---
    const placementChain: readonly PlacementId[] = [
      requirement.placement.required,
      ...(requirement.placement.fallbackOrder ?? []),
    ];
    let satisfiedPlacement: PlacementId | null = null;
    let placementRank: number | null = null;
    for (let index = 0; index < placementChain.length; index += 1) {
      const entry = placementChain[index] as PlacementId;
      if (placementSatisfiedByLocationClass(entry, record.locationClass)) {
        satisfiedPlacement = entry;
        placementRank = index;
        break;
      }
    }
    let placementEligible = true;
    if (satisfiedPlacement === null) {
      placementEligible = false;
      if (requirement.placement.required === 'device_local') {
        reasons.push({
          dimension: 'placement',
          code: 'PLACEMENT_LOCALITY_VIOLATION',
          detail: `device_local is a locality correctness constraint and node ${record.nodeId} is a ${record.locationClass} node (${record.platformClass})`,
        });
      } else {
        reasons.push({
          dimension: 'placement',
          code: 'PLACEMENT_CLASS_MISMATCH',
          detail: `node ${record.nodeId} is a ${record.locationClass} node (${record.platformClass}) and does not satisfy placement chain ${placementChain.join(' → ')}`,
        });
      }
    }
    if (requirement.privacy?.localOnly === true && record.locationClass === 'cloud') {
      placementEligible = false;
      reasons.push({
        dimension: 'placement',
        code: 'PRIVACY_LOCAL_ONLY_VIOLATION',
        detail: `requirement forbids data leaving the device (localOnly) and node ${record.nodeId} is a cloud node`,
      });
    }
    if (requirement.humanApprovalRequired === true && !record.attributes.supportsHumanApproval) {
      placementEligible = false;
      reasons.push({
        dimension: 'placement',
        code: 'HUMAN_APPROVAL_NOT_SUPPORTED',
        detail: `requirement needs a human-approval surface and node ${record.nodeId} does not declare one`,
      });
    }

    // --- trust dimension (own dimension, never capability, never authorization) ---
    let trustEligible = true;
    if (
      requirement.minTrustTier !== undefined &&
      TRUST_TIER_RANK[record.trust.trustTier] < TRUST_TIER_RANK[requirement.minTrustTier]
    ) {
      trustEligible = false;
      reasons.push({
        dimension: 'trust',
        code: 'TRUST_TIER_BELOW_MINIMUM',
        detail: `node trust tier "${record.trust.trustTier}" is below the required minimum "${requirement.minTrustTier}"`,
      });
    }

    // --- health dimension: liveness lease + declared health ---
    let healthEligible = true;
    if (
      record.lastHeartbeatAt === null ||
      now > record.lastHeartbeatAt + this.heartbeatLeaseTtlMs
    ) {
      healthEligible = false;
      reasons.push({
        dimension: 'health',
        code: 'HEARTBEAT_STALE',
        detail: `node ${record.nodeId} heartbeat lease expired (last heartbeat ${String(record.lastHeartbeatAt)}, lease TTL ${String(this.heartbeatLeaseTtlMs)} ms, evaluated at ${String(now)})`,
      });
    }
    const minHealth = requirement.minNodeHealth ?? DEFAULT_MIN_NODE_HEALTH;
    if (HEALTH_RANK[record.attributes.health] < HEALTH_RANK[minHealth]) {
      healthEligible = false;
      reasons.push({
        dimension: 'health',
        code: 'HEALTH_BELOW_MINIMUM',
        detail: `node declares health "${record.attributes.health}" which is below the required minimum "${minHealth}"`,
      });
    }

    const eligible =
      protocolEligible && capabilityEligible && placementEligible && trustEligible && healthEligible;

    // Placement preference data is meaningful only for placement-eligible
    // nodes (a rank on an ineligible node would misrepresent preference).
    const reportedPlacement = placementEligible ? satisfiedPlacement : null;
    const reportedPlacementRank = placementEligible ? placementRank : null;

    return {
      nodeId: record.nodeId,
      platformClass: record.platformClass,
      locationClass: record.locationClass,
      protocolEligible,
      capabilityEligible,
      placementEligible,
      trustEligible,
      healthEligible,
      eligible,
      satisfiedPlacement: reportedPlacement,
      placementRank: reportedPlacementRank,
      reasons,
    };
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private requireRecord(nodeId: string): NodeRecord {
    const record = this.nodeStore.getRecord(nodeId);
    if (record === null) {
      throw new NodeCapabilityError('NODE_NOT_FOUND', `node ${nodeId} is not registered`);
    }
    return record;
  }

  private requireValidSession(record: NodeRecord, sessionToken: string): void {
    const session = this.nodeStore.getSession(record.nodeId);
    if (session === null) {
      throw new NodeCapabilityError(
        'NODE_SESSION_INVALID',
        `node ${record.nodeId} has no active session (register first)`,
      );
    }
    const secret = this.keyStore.getSecret(record.nodeKeyFingerprint);
    if (secret === null) {
      throw new NodeCapabilityError(
        'NODE_SESSION_INVALID',
        `node key material for ${record.nodeId} is no longer available`,
      );
    }
    const expected = computeSessionToken({
      nodeKeySecret: secret,
      nodeKeyFingerprint: record.nodeKeyFingerprint,
      serial: session.serial,
    });
    if (expected !== sessionToken) {
      throw new NodeCapabilityError(
        'NODE_SESSION_INVALID',
        `session token does not match the active session for node ${record.nodeId} (serial ${String(session.serial)}); re-registration invalidates earlier tokens`,
      );
    }
  }
}

/** Requirement-set validation (fail closed — invalid requirements never match). */
function validateRequirementSet(requirement: NodeRequirementSet): void {
  validateCapabilityRequirements(requirement.capabilities);
  validatePlacementConstraint(requirement.placement);
  if (requirement.privacy !== undefined && typeof requirement.privacy.localOnly !== 'boolean') {
    throw new NodeCapabilityError(
      'REQUIREMENT_INVALID',
      `privacy.localOnly must be a boolean (got ${typeof requirement.privacy.localOnly})`,
    );
  }
  if (requirement.humanApprovalRequired !== undefined && typeof requirement.humanApprovalRequired !== 'boolean') {
    throw new NodeCapabilityError(
      'REQUIREMENT_INVALID',
      `humanApprovalRequired must be a boolean (got ${typeof requirement.humanApprovalRequired})`,
    );
  }
  if (requirement.minTrustTier !== undefined && !isNodeTrustTier(requirement.minTrustTier)) {
    throw new NodeCapabilityError(
      'REQUIREMENT_INVALID',
      `minTrustTier "${String(requirement.minTrustTier)}" is not one of untrusted, provisional, trusted`,
    );
  }
  if (requirement.minNodeHealth !== undefined && !isNodeHealthStatus(requirement.minNodeHealth)) {
    throw new NodeCapabilityError(
      'REQUIREMENT_INVALID',
      `minNodeHealth "${String(requirement.minNodeHealth)}" is not one of unhealthy, degraded, healthy`,
    );
  }
  if (
    requirement.minProtocolVersion !== undefined &&
    (!Number.isInteger(requirement.minProtocolVersion) || requirement.minProtocolVersion < 1)
  ) {
    throw new NodeCapabilityError(
      'REQUIREMENT_INVALID',
      `minProtocolVersion ${String(requirement.minProtocolVersion)} must be an integer ≥ 1`,
    );
  }
}

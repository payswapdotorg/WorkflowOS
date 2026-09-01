/**
 * V2-004 — Node + Capability Protocol (public barrel).
 *
 * Owns (spec/architecture/v2/work-orders/V2-004.md): node identity,
 * capability advertisement/versioning, capability requirement matching,
 * placement/locality/privacy constraints, node trust/health attributes, and
 * cross-host conformance fixtures.
 *
 * Deliberately does NOT own: workflow repository/versioning (V2-002),
 * WorkflowIR semantics (V2-003 — requirement sets are consumed as DATA
 * here), run/evidence persistence (V2-005), the execution-truth/trust
 * protocol (V2-014), scheduling/events, optimization, marketplace, or
 * platform-specific workflow semantics.
 *
 * Capability advertisement is never authorization (constitution §5): match
 * results answer capability/placement/trust/health eligibility only, and
 * the API shape structurally keeps the authorization dimension out.
 */
export type {
  CapabilityAdvertisement,
  CapabilityAvailability,
  CapabilityRequirement,
  EligibilityDimension,
  ExpectedNodeEligibility,
  HostAdvertisementFixture,
  HostConformanceFixture,
  NodeCapabilityErrorCode,
  NodeCapabilityService,
  NodeDeclaredAttributes,
  NodeEligibilityEvaluation,
  NodeEligibilityReason,
  NodeEligibilityReasonCode,
  NodeHealthStatus,
  NodeKeyStore,
  NodeLiveness,
  NodeLocationClass,
  NodeMatchResult,
  NodePlatformClass,
  NodeRecord,
  NodeRecordStore,
  NodeRegistrationPayload,
  NodeRegistrationRequest,
  NodeRequirementSet,
  NodeSession,
  NodeSessionRecord,
  NodeTrustAttributes,
  NodeTrustTier,
  PlacementConstraint,
  PlacementId,
  PrivacyConstraint,
  RegistrationChallenge,
} from './types.js';
export {
  CAPABILITY_AVAILABILITIES,
  ELIGIBILITY_DIMENSIONS,
  HARD_LOCALITY_PLACEMENT_IDS,
  NODE_CAPABILITY_ERROR_CODES,
  NODE_CAPABILITY_PROTOCOL_VERSION,
  NODE_ELIGIBILITY_REASON_CODES,
  NODE_HEALTH_STATUSES,
  NODE_LOCATION_CLASSES,
  NODE_PLATFORM_CLASSES,
  NODE_TRUST_TIERS,
  PLACEMENT_IDS,
  SUPPORTED_NODE_PROTOCOL_VERSIONS,
  NodeCapabilityError,
  nodeLocationClassOf,
} from './types.js';

export { CANONICAL_CAPABILITY_NAMES, CANONICAL_PLACEMENT_IDS } from './internal/canonical-registry.js';
export {
  canonicalJsonString,
  computeRegistrationResponse,
  deriveNodeKeyFingerprint,
} from './internal/node-auth.js';
export { DefaultNodeCapabilityService } from './internal/node-capability-service.js';
export type { DefaultNodeCapabilityServiceDeps } from './internal/node-capability-service.js';
export {
  InMemoryNodeKeyStore,
  InMemoryNodeRecordStore,
  makeSequentialNonceSource,
} from './internal/in-memory-node-store.js';
export { NODE_CAPABILITY_CONFORMANCE_FIXTURES } from './internal/conformance-fixtures.js';

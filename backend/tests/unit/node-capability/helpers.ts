import { createHash } from 'node:crypto';
import {
  DefaultNodeCapabilityService,
  computeRegistrationResponse,
  type CapabilityAdvertisement,
  type DefaultNodeCapabilityServiceDeps,
  type NodeCapabilityService,
  type NodeDeclaredAttributes,
  type NodeEligibilityEvaluation,
  type NodeMatchResult,
  type NodePlatformClass,
  type NodeRecordStore,
  type NodeTrustTier,
  type NodeKeyStore,
} from '../../../src/node-capability/index.js';

/**
 * V2-004 unit-test helpers — deterministic harness construction.
 *
 * Every service is built with an INJECTED fixed clock and the default
 * sequential (deterministic) nonce source: no wall-clock, no randomness, no
 * network. Node key secrets are derived deterministically from test seeds via
 * SHA-256, so node ids are stable across runs.
 */

export const T0 = 1_700_000_000_000;

export interface FixedClock {
  readonly clock: () => number;
  readonly advance: (ms: number) => void;
  readonly now: () => number;
}

export function fixedClock(start: number = T0): FixedClock {
  let t = start;
  return {
    clock: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

export interface ServiceHarness {
  readonly service: NodeCapabilityService;
  readonly clock: FixedClock;
}

export function buildService(options?: {
  readonly clock?: FixedClock;
  readonly keyStore?: NodeKeyStore;
  readonly nodeStore?: NodeRecordStore;
  readonly supportedProtocolVersions?: readonly number[];
  readonly heartbeatLeaseTtlMs?: number;
  readonly registrationChallengeTtlMs?: number;
}): ServiceHarness {
  const clock = options?.clock ?? fixedClock();
  const deps: DefaultNodeCapabilityServiceDeps = {
    clock: clock.clock,
    ...(options?.keyStore !== undefined ? { keyStore: options.keyStore } : {}),
    ...(options?.nodeStore !== undefined ? { nodeStore: options.nodeStore } : {}),
    ...(options?.supportedProtocolVersions !== undefined
      ? { supportedProtocolVersions: options.supportedProtocolVersions }
      : {}),
    ...(options?.heartbeatLeaseTtlMs !== undefined
      ? { heartbeatLeaseTtlMs: options.heartbeatLeaseTtlMs }
      : {}),
    ...(options?.registrationChallengeTtlMs !== undefined
      ? { registrationChallengeTtlMs: options.registrationChallengeTtlMs }
      : {}),
  };
  const service = new DefaultNodeCapabilityService(deps);
  return { service, clock };
}

/** Deterministic node key material for a test seed (real SHA-256 bytes). */
export function testNodeSecret(seed: string): Uint8Array {
  return createHash('sha256').update(`v2-004-unit-test-node-key:${seed}`).digest();
}

export const DEFAULT_TEST_CAPABILITY: CapabilityAdvertisement = {
  name: 'workflow.observe',
  version: 1,
  availability: 'available',
};

export const DEFAULT_TEST_ATTRIBUTES: NodeDeclaredAttributes = {
  supportsHumanApproval: false,
  health: 'healthy',
};

export interface RegisterTestNodeInput {
  readonly seed: string;
  readonly platformClass: NodePlatformClass;
  readonly protocolVersion?: number;
  readonly capabilities?: readonly CapabilityAdvertisement[];
  readonly attributes?: NodeDeclaredAttributes;
  readonly trustTier?: NodeTrustTier;
}

export interface RegisteredTestNode {
  readonly nodeId: string;
  readonly sessionToken: string;
}

/**
 * Registers a node through the REAL protocol path: key enrollment →
 * challenge → HMAC challenge-response (real node:crypto HMAC-SHA256) →
 * registration → trust attributes.
 */
export function registerTestNode(
  service: NodeCapabilityService,
  input: RegisterTestNodeInput,
): RegisteredTestNode {
  const secret = testNodeSecret(input.seed);
  const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
  const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
  const payload = {
    nodeKeyFingerprint,
    platformClass: input.platformClass,
    protocolVersion: input.protocolVersion ?? 1,
    capabilities: input.capabilities ?? [DEFAULT_TEST_CAPABILITY],
    attributes: input.attributes ?? DEFAULT_TEST_ATTRIBUTES,
  };
  const response = computeRegistrationResponse({
    nodeKeySecret: secret,
    payload,
    nonce: challenge.nonce,
  });
  const session = service.completeRegistration({
    ...payload,
    challengeNonce: challenge.nonce,
    response,
  });
  service.setNodeTrustAttributes({ nodeId: session.nodeId, trustTier: input.trustTier ?? 'trusted' });
  return { nodeId: session.nodeId, sessionToken: session.sessionToken };
}

export function reasonCodes(evaluation: NodeEligibilityEvaluation): readonly string[] {
  return evaluation.reasons.map((r) => r.code);
}

export function findEvaluation(
  result: NodeMatchResult,
  nodeId: string,
): NodeEligibilityEvaluation {
  const evaluation = result.evaluations.find((e) => e.nodeId === nodeId);
  if (!evaluation) {
    throw new Error(`no evaluation for node ${nodeId}; got ${result.evaluations.map((e) => e.nodeId).join(', ')}`);
  }
  return evaluation;
}

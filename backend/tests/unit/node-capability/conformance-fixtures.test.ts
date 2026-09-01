import { describe, it, expect } from 'vitest';
import {
  NODE_CAPABILITY_CONFORMANCE_FIXTURES,
  computeRegistrationResponse,
  DefaultNodeCapabilityService,
  type HostConformanceFixture,
  type NodeCapabilityService,
  type NodeEligibilityEvaluation,
} from '../../../src/node-capability/index.js';
import { fixedClock, reasonCodes, T0, testNodeSecret } from './helpers.js';

/**
 * V2-004 — exported cross-host protocol conformance fixtures.
 *
 * The fixture sets are the SHARED conformance contract for host classes
 * (cloud / web / desktop / ios / android): host-class capability
 * advertisements + requirement sets + expected eligibility outcomes. They are
 * consumable by future host implementations and by IG-002, and this suite
 * proves they are satisfied by the REAL service (real HMAC registration,
 * deterministic injected clock — no mocks of the protocol itself).
 */
describe('V2-004 conformance fixtures resolve through the real service', () => {
  for (const fixture of NODE_CAPABILITY_CONFORMANCE_FIXTURES) {
    it(`fixture ${fixture.id}: ${fixture.description}`, () => {
      const outcomes = runFixture(fixture);
      expect(outcomes.size).toBe(fixture.advertisements.length);
      for (const expected of fixture.expectedOutcomes) {
        const actual = outcomes.get(expected.nodeAdvertisementId);
        expect(actual, `no evaluation for advertisement ${expected.nodeAdvertisementId}`).toBeDefined();
        const evaluation = actual as NodeEligibilityEvaluation;
        expect(evaluation.nodeId).toBeDefined();
        expect(evaluation.eligible).toBe(expected.eligible);
        expect(evaluation.protocolEligible).toBe(expected.protocolEligible);
        expect(evaluation.capabilityEligible).toBe(expected.capabilityEligible);
        expect(evaluation.placementEligible).toBe(expected.placementEligible);
        expect(evaluation.trustEligible).toBe(expected.trustEligible);
        expect(evaluation.healthEligible).toBe(expected.healthEligible);
        expect(evaluation.placementRank).toBe(expected.placementRank);
        expect([...reasonCodes(evaluation)].sort()).toEqual([...expected.reasonCodes].sort());
      }
    });
  }

  it('every fixture has at least one advertisement and expected outcomes for ALL advertisements', () => {
    for (const fixture of NODE_CAPABILITY_CONFORMANCE_FIXTURES) {
      expect(fixture.advertisements.length).toBeGreaterThan(0);
      const expectedIds = new Set(fixture.expectedOutcomes.map((o) => o.nodeAdvertisementId));
      expect(expectedIds.size).toBe(fixture.advertisements.length);
      for (const ad of fixture.advertisements) {
        expect(expectedIds.has(ad.id), `${fixture.id}: missing expected outcome for ${ad.id}`).toBe(true);
      }
    }
  });

  it('cross-surface fixture pairs prove equivalent eligibility across host classes', () => {
    const crossSurface = NODE_CAPABILITY_CONFORMANCE_FIXTURES.filter((f) => f.crossSurfaceEquivalence !== undefined);
    expect(crossSurface.length).toBeGreaterThanOrEqual(1);
    for (const fixture of crossSurface) {
      const outcomes = runFixture(fixture);
      const pair = fixture.crossSurfaceEquivalence as { readonly a: string; readonly b: string };
      const a = outcomes.get(pair.a) as NodeEligibilityEvaluation;
      const b = outcomes.get(pair.b) as NodeEligibilityEvaluation;
      expect(a.platformClass).not.toBe(b.platformClass); // genuinely different host classes
      expect(a.capabilityEligible).toBe(b.capabilityEligible);
      expect(a.protocolEligible).toBe(b.protocolEligible);
      expect(a.trustEligible).toBe(b.trustEligible);
      expect(a.healthEligible).toBe(b.healthEligible);
      expect(a.eligible).toBe(b.eligible);
      expect(a.placementRank).toBe(b.placementRank);
      expect([...reasonCodes(a)].sort()).toEqual([...reasonCodes(b)].sort());
    }
  });

  it('fixtures are deterministic: re-running produces identical outcomes', () => {
    for (const fixture of NODE_CAPABILITY_CONFORMANCE_FIXTURES) {
      const first = runFixture(fixture);
      const second = runFixture(fixture);
      expect([...second.entries()].map(([id, e]) => [id, reasonCodes(e), e.placementRank])).toEqual(
        [...first.entries()].map(([id, e]) => [id, reasonCodes(e), e.placementRank]),
      );
    }
  });
});

/**
 * Runs one fixture through the REAL protocol path with a deterministic
 * clock. Advertisement `heartbeatAgeMs` fixes each node's heartbeat age at
 * evaluation time: nodes are registered at `T_EVALUATION - age`, so a node
 * with age > lease TTL is honestly stale at match time.
 */
function runFixture(fixture: HostConformanceFixture): Map<string, NodeEligibilityEvaluation> {
  const clock = fixedClock(T0);
  const service: NodeCapabilityService = new DefaultNodeCapabilityService({
    clock: clock.clock,
    ...(fixture.supportedProtocolVersions !== undefined
      ? { supportedProtocolVersions: fixture.supportedProtocolVersions }
      : {}),
  });
  const evaluationTime = T0 + Math.max(...fixture.advertisements.map((a) => a.heartbeatAgeMs));
  const byRegistrationTime = [...fixture.advertisements].sort(
    (a, b) => b.heartbeatAgeMs - a.heartbeatAgeMs,
  );
  const nodeIdByAdvertisementId = new Map<string, string>();
  // Register from the OLDEST heartbeat forward so every node's age is exact.
  for (const ad of byRegistrationTime) {
    clock.advance(evaluationTime - ad.heartbeatAgeMs - clock.now());
    const secret = testNodeSecret(`${fixture.keySeed}:${ad.id}`);
    const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
    const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
    const payload = {
      nodeKeyFingerprint,
      platformClass: ad.platformClass,
      protocolVersion: ad.protocolVersion,
      capabilities: ad.capabilities,
      attributes: ad.attributes,
    };
    const response = computeRegistrationResponse({ nodeKeySecret: secret, payload, nonce: challenge.nonce });
    const session = service.completeRegistration({
      ...payload,
      challengeNonce: challenge.nonce,
      response,
    });
    service.setNodeTrustAttributes({ nodeId: session.nodeId, trustTier: ad.trustTier });
    nodeIdByAdvertisementId.set(ad.id, session.nodeId);
  }
  clock.advance(evaluationTime - clock.now());
  const result = service.matchNodes(fixture.requirementSet);
  const outcomes = new Map<string, NodeEligibilityEvaluation>();
  for (const [adId, nodeId] of nodeIdByAdvertisementId) {
    const evaluation = result.evaluations.find((e) => e.nodeId === nodeId);
    expect(evaluation, `fixture ${fixture.id}: no evaluation for ${adId}`).toBeDefined();
    outcomes.set(adId, evaluation as NodeEligibilityEvaluation);
  }
  return outcomes;
}

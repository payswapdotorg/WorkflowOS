import { describe, it, expect } from 'vitest';
import {
  NodeCapabilityError,
  computeRegistrationResponse,
} from '../../../src/node-capability/index.js';
import {
  buildService,
  registerTestNode,
  testNodeSecret,
  T0,
} from './helpers.js';

/**
 * V2-004 — node registration channel authentication.
 *
 * Node identity is authenticated by a REAL nonce challenge-response over
 * node-scoped key material (HMAC-SHA256 via node:crypto — message
 * authentication of a registration channel, nothing more: it asserts channel
 * authenticity, never execution truth). Registration binds the WHOLE payload
 * (platform class, protocol version, capability advertisement, attributes)
 * under the MAC, expires and burns nonces single-use, and fails closed on
 * every tampering path.
 */
describe('V2-004 node registration protocol', () => {
  it('registers an authenticated node and derives a deterministic node id from its key material', () => {
    const { service } = buildService();
    const node = registerTestNode(service, { seed: 'cloud-1', platformClass: 'cloud' });
    expect(node.nodeId).toMatch(/^node_[0-9a-f]{16}$/);
    expect(node.sessionToken).toMatch(/^[0-9a-f]{64}$/);

    const node2 = registerTestNode(buildService().service, { seed: 'cloud-1', platformClass: 'cloud' });
    expect(node2.nodeId).toBe(node.nodeId); // deterministic identity input (the key)
    const other = registerTestNode(buildService().service, { seed: 'cloud-2', platformClass: 'cloud' });
    expect(other.nodeId).not.toBe(node.nodeId);

    const record = service.getNode(node.nodeId);
    expect(record?.platformClass).toBe('cloud');
    expect(record?.locationClass).toBe('cloud');
    expect(record?.protocolVersion).toBe(1);
    expect(record?.registeredAt).toBe(T0);
    // Registration itself counts as the initial liveness signal.
    expect(record?.lastHeartbeatAt).toBe(T0);
  });

  it('derives device location class for web/desktop/ios/android platform classes', () => {
    const { service } = buildService();
    for (const platformClass of ['web', 'desktop', 'ios', 'android'] as const) {
      const node = registerTestNode(service, { seed: `dev-${platformClass}`, platformClass });
      expect(service.getNode(node.nodeId)?.locationClass).toBe('device');
    }
  });

  it('rejects a challenge-response computed with the WRONG key (fail closed, nothing registered)', () => {
    const { service } = buildService();
    const secret = testNodeSecret('real-key');
    const wrongSecret = testNodeSecret('attacker-key');
    const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
    const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
    const payload = {
      nodeKeyFingerprint,
      platformClass: 'cloud' as const,
      protocolVersion: 1,
      capabilities: [{ name: 'workflow.execute', version: 1, availability: 'available' as const }],
      attributes: { supportsHumanApproval: false, health: 'healthy' as const },
    };
    const forged = computeRegistrationResponse({
      nodeKeySecret: wrongSecret,
      payload,
      nonce: challenge.nonce,
    });
    expect(() =>
      service.completeRegistration({ ...payload, challengeNonce: challenge.nonce, response: forged }),
    ).toThrowError(NodeCapabilityError);
    try {
      service.completeRegistration({ ...payload, challengeNonce: challenge.nonce, response: forged });
    } catch (error) {
      expect((error as NodeCapabilityError).code).toBe('REGISTRATION_RESPONSE_INVALID');
    }
    expect(service.listNodes()).toHaveLength(0);
  });

  it('rejects registration when the payload was tampered after the response was computed', () => {
    // The MAC covers the WHOLE registration payload: swapping the platform
    // class or capability list after the fact is a forgery.
    const { service } = buildService();
    const secret = testNodeSecret('tamper-key');
    const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
    const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
    const honestPayload = {
      nodeKeyFingerprint,
      platformClass: 'web' as const,
      protocolVersion: 1,
      capabilities: [{ name: 'browser.navigate', version: 1, availability: 'available' as const }],
      attributes: { supportsHumanApproval: false, health: 'healthy' as const },
    };
    const response = computeRegistrationResponse({
      nodeKeySecret: secret,
      payload: honestPayload,
      nonce: challenge.nonce,
    });
    const tampered = {
      ...honestPayload,
      platformClass: 'cloud' as const, // platform class swapped in transit
    };
    expect(() =>
      service.completeRegistration({ ...tampered, challengeNonce: challenge.nonce, response }),
    ).toThrowError(/REGISTRATION_RESPONSE_INVALID/);
    expect(service.listNodes()).toHaveLength(0);
  });

  it('fails closed for unenrolled node key fingerprints', () => {
    const { service } = buildService();
    expect(() => service.requestRegistrationChallenge({ nodeKeyFingerprint: 'node_deadbeef0000ffff' })).toThrowError(
      /NODE_KEY_NOT_ENROLLED/,
    );
  });

  it('expires registration challenges (injected deterministic clock)', () => {
    const { service, clock } = buildService();
    const secret = testNodeSecret('expire-key');
    const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
    const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
    const payload = {
      nodeKeyFingerprint,
      platformClass: 'cloud' as const,
      protocolVersion: 1,
      capabilities: [{ name: 'workflow.execute', version: 1, availability: 'available' as const }],
      attributes: { supportsHumanApproval: false, health: 'healthy' as const },
    };
    const response = computeRegistrationResponse({
      nodeKeySecret: secret,
      payload,
      nonce: challenge.nonce,
    });
    clock.advance(60_001); // default challenge TTL is 60s
    expect(() =>
      service.completeRegistration({ ...payload, challengeNonce: challenge.nonce, response }),
    ).toThrowError(/REGISTRATION_CHALLENGE_EXPIRED/);
    expect(service.listNodes()).toHaveLength(0);
  });

  it('burns each registration nonce single-use (no replay)', () => {
    const { service } = buildService();
    const secret = testNodeSecret('replay-key');
    const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
    const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
    const payload = {
      nodeKeyFingerprint,
      platformClass: 'cloud' as const,
      protocolVersion: 1,
      capabilities: [{ name: 'workflow.execute', version: 1, availability: 'available' as const }],
      attributes: { supportsHumanApproval: false, health: 'healthy' as const },
    };
    const response = computeRegistrationResponse({
      nodeKeySecret: secret,
      payload,
      nonce: challenge.nonce,
    });
    service.completeRegistration({ ...payload, challengeNonce: challenge.nonce, response });
    expect(() =>
      service.completeRegistration({ ...payload, challengeNonce: challenge.nonce, response }),
    ).toThrowError(/REGISTRATION_CHALLENGE_ALREADY_USED/);
    expect(service.listNodes()).toHaveLength(1);
  });

  it('rejects an unknown challenge nonce', () => {
    const { service } = buildService();
    const secret = testNodeSecret('unknown-nonce');
    const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
    service.requestRegistrationChallenge({ nodeKeyFingerprint });
    const payload = {
      nodeKeyFingerprint,
      platformClass: 'cloud' as const,
      protocolVersion: 1,
      capabilities: [{ name: 'workflow.execute', version: 1, availability: 'available' as const }],
      attributes: { supportsHumanApproval: false, health: 'healthy' as const },
    };
    const response = computeRegistrationResponse({
      nodeKeySecret: secret,
      payload,
      nonce: '00000000000000ff',
    });
    expect(() =>
      service.completeRegistration({ ...payload, challengeNonce: '00000000000000ff', response }),
    ).toThrowError(/REGISTRATION_CHALLENGE_NOT_FOUND/);
  });

  it('rejects nodes advertising an unsupported protocol version (fail closed at registration)', () => {
    const { service } = buildService();
    expect(() =>
      registerTestNode(service, { seed: 'proto-99', platformClass: 'cloud', protocolVersion: 99 }),
    ).toThrowError(/NODE_PROTOCOL_VERSION_UNSUPPORTED/);
    expect(service.listNodes()).toHaveLength(0);

    const wide = buildService({ supportedProtocolVersions: [1, 2] });
    const node = registerTestNode(wide.service, {
      seed: 'proto-2',
      platformClass: 'cloud',
      protocolVersion: 2,
    });
    expect(wide.service.getNode(node.nodeId)?.protocolVersion).toBe(2);
  });

  it('rejects unknown platform classes', () => {
    const { service } = buildService();
    expect(() =>
      registerTestNode(service, { seed: 'bad-class', platformClass: 'serverless' as never }),
    ).toThrowError(/PLATFORM_CLASS_INVALID/);
    expect(service.listNodes()).toHaveLength(0);
  });

  it('invalidates the previous session when a node re-registers', () => {
    const { service } = buildService();
    const first = registerTestNode(service, { seed: 'rereg', platformClass: 'cloud' });
    const second = registerTestNode(service, { seed: 'rereg', platformClass: 'cloud' });
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.sessionToken).not.toBe(first.sessionToken);
    expect(() =>
      service.heartbeat({ nodeId: first.nodeId, sessionToken: first.sessionToken }),
    ).toThrowError(/NODE_SESSION_INVALID/);
    expect(service.heartbeat({ nodeId: second.nodeId, sessionToken: second.sessionToken })).toBeTruthy();
  });

  it('rejects heartbeat and advertisement updates with an invalid session token', () => {
    const { service } = buildService();
    const node = registerTestNode(service, { seed: 'session-guard', platformClass: 'web' });
    expect(() =>
      service.heartbeat({ nodeId: node.nodeId, sessionToken: 'f'.repeat(64) }),
    ).toThrowError(/NODE_SESSION_INVALID/);
    expect(() =>
      service.updateAdvertisement({
        nodeId: node.nodeId,
        sessionToken: 'f'.repeat(64),
        capabilities: [{ name: 'browser.observe', version: 1, availability: 'available' }],
      }),
    ).toThrowError(/NODE_SESSION_INVALID/);
    expect(() => service.heartbeat({ nodeId: 'node_0000000000000000', sessionToken: node.sessionToken })).toThrowError(
      /NODE_NOT_FOUND/,
    );
    // The record is unchanged by the rejected mutation.
    expect(service.getNode(node.nodeId)?.capabilities.map((c) => c.name)).toEqual(['workflow.observe']);
  });

  it('replaces the whole advertisement atomically on an authenticated update (validated, no partial state)', () => {
    const { service } = buildService();
    const node = registerTestNode(service, { seed: 'adv-update', platformClass: 'web' });
    const next = [
      { name: 'browser.navigate', version: 2, availability: 'available' as const },
      { name: 'browser.observe', version: 1, availability: 'available' as const },
    ];
    const record = service.updateAdvertisement({
      nodeId: node.nodeId,
      sessionToken: node.sessionToken,
      capabilities: next,
    });
    expect(record.capabilities).toEqual(next);
    // Invalid update is rejected without mutating the current advertisement.
    expect(() =>
      service.updateAdvertisement({
        nodeId: node.nodeId,
        sessionToken: node.sessionToken,
        capabilities: [
          { name: 'phone.answer_call', version: 1, availability: 'available' as const },
        ],
      }),
    ).toThrowError(/CAPABILITY_NAME_NOT_CANONICAL/);
    expect(service.getNode(node.nodeId)?.capabilities).toEqual(next);
  });

  it('accepts an authenticated heartbeat and reports the lease window', () => {
    const { service, clock } = buildService();
    const node = registerTestNode(service, { seed: 'hb', platformClass: 'web' });
    clock.advance(10_000);
    const liveness = service.heartbeat({ nodeId: node.nodeId, sessionToken: node.sessionToken });
    expect(liveness.lastHeartbeatAt).toBe(T0 + 10_000);
    expect(liveness.leaseExpiresAt).toBe(T0 + 10_000 + 60_000);
    expect(liveness.health).toBe('healthy');
    const degraded = service.heartbeat({
      nodeId: node.nodeId,
      sessionToken: node.sessionToken,
      health: 'degraded',
    });
    expect(degraded.health).toBe('degraded');
    expect(service.getNode(node.nodeId)?.attributes.health).toBe('degraded');
    expect(() =>
      service.heartbeat({ nodeId: node.nodeId, sessionToken: node.sessionToken, health: 'dying' as never }),
    ).toThrowError(/HEALTH_STATUS_INVALID/);
  });

  it('sets node trust attributes through the administrative plane (not self-declared by nodes)', () => {
    const { service } = buildService();
    const node = registerTestNode(service, { seed: 'trust-plane', platformClass: 'cloud', trustTier: 'provisional' });
    expect(service.getNode(node.nodeId)?.trust.trustTier).toBe('provisional');
    const updated = service.setNodeTrustAttributes({ nodeId: node.nodeId, trustTier: 'trusted' });
    expect(updated.trust.trustTier).toBe('trusted');
    expect(() =>
      service.setNodeTrustAttributes({ nodeId: node.nodeId, trustTier: 'semi' as never }),
    ).toThrowError(/TRUST_TIER_INVALID/);
  });
});

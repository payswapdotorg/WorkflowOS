import { describe, it, expect } from 'vitest';
import { InMemoryNodeRecordStore, InMemoryNodeKeyStore } from '../../../src/node-capability/index.js';
import { buildService, findEvaluation, reasonCodes, registerTestNode } from './helpers.js';

/**
 * V2-004 — node liveness (heartbeat/lease) and protocol-version gating.
 *
 * Both use the INJECTED deterministic clock: no wall-clock dependence.
 * A stale node (heartbeat lease expired) is EXCLUDED from matching — never
 * silently included. A node whose protocol version is unsupported is
 * fail-closed at registration AND at matching.
 */
describe('V2-004 stale-node exclusion (heartbeat lease)', () => {
  it('excludes a node whose heartbeat lease has expired; a fresh heartbeat re-includes it', () => {
    const { service, clock } = buildService();
    const web = registerTestNode(service, { seed: 'stale-web', platformClass: 'web' });
    const requirement = {
      capabilities: [{ name: 'workflow.observe' as const }],
      placement: { required: 'any_supported_node' as const },
    };

    // Fresh at registration time.
    expect(service.matchNodes(requirement).eligibleNodes.map((e) => e.nodeId)).toEqual([web.nodeId]);

    // 59_999 ms later — still inside the default 60s lease (inclusive
    // boundary: the lease is valid through lastHeartbeatAt + TTL).
    clock.advance(59_999);
    expect(service.matchNodes(requirement).eligibleNodes.map((e) => e.nodeId)).toEqual([web.nodeId]);

    // 2 ms past the lease boundary → excluded, explicitly.
    clock.advance(2);
    const stale = service.matchNodes(requirement);
    const evaluation = findEvaluation(stale, web.nodeId);
    expect(evaluation.healthEligible).toBe(false);
    expect(evaluation.eligible).toBe(false);
    expect(reasonCodes(evaluation)).toEqual(['HEARTBEAT_STALE']);
    expect(evaluation.reasons[0]?.dimension).toBe('health');
    // Other dimensions are still honestly evaluated and reported.
    expect(evaluation.capabilityEligible).toBe(true);
    expect(evaluation.placementEligible).toBe(true);
    expect(evaluation.trustEligible).toBe(true);
    expect(stale.eligibleNodes).toHaveLength(0);

    // Fresh heartbeat → included again.
    service.heartbeat({ nodeId: web.nodeId, sessionToken: web.sessionToken });
    expect(service.matchNodes(requirement).eligibleNodes.map((e) => e.nodeId)).toEqual([web.nodeId]);
  });

  it('honors a configured lease TTL deterministically', () => {
    const { service, clock } = buildService({ heartbeatLeaseTtlMs: 5_000 });
    const cloud = registerTestNode(service, { seed: 'ttl-cloud', platformClass: 'cloud' });
    clock.advance(5_000);
    const requirement = {
      capabilities: [{ name: 'workflow.observe' as const }],
      placement: { required: 'cloud_required' as const },
    };
    expect(service.matchNodes(requirement).eligibleNodes.map((e) => e.nodeId)).toEqual([cloud.nodeId]);
    clock.advance(1);
    expect(service.matchNodes(requirement).eligibleNodes).toHaveLength(0);
  });

  it('a stale node never silently wins a placement preference over a fresh node', () => {
    const { service, clock } = buildService();
    const staleWeb = registerTestNode(service, { seed: 'stale-pref-web', platformClass: 'web' });
    const freshCloud = registerTestNode(service, { seed: 'fresh-pref-cloud', platformClass: 'cloud' });
    clock.advance(120_000); // both leases lapse
    service.heartbeat({ nodeId: freshCloud.nodeId, sessionToken: freshCloud.sessionToken });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] },
    });
    // The PREFERRED device node is stale: only the fresh cloud node (via the
    // explicit fallback) is eligible — no silent inclusion of the stale
    // preferred node.
    expect(result.eligibleNodes.map((e) => e.nodeId)).toEqual([freshCloud.nodeId]);
    const staleEvaluation = findEvaluation(result, staleWeb.nodeId);
    expect(staleEvaluation.placementRank).toBe(0);
    expect(staleEvaluation.healthEligible).toBe(false);
  });
});

describe('V2-004 protocol-version gating (fail closed)', () => {
  it('excludes a node at MATCHING time when its protocol version is not supported by the evaluating service', () => {
    // One shared in-memory store; two services with different supported
    // version sets — the store port is the seam that makes the
    // matching-time fail-closed path real.
    const keyStore = new InMemoryNodeKeyStore();
    const nodeStore = new InMemoryNodeRecordStore();
    const modern = buildService({ keyStore, nodeStore, supportedProtocolVersions: [1, 2] });
    const v2Node = registerTestNode(modern.service, {
      seed: 'proto-v2',
      platformClass: 'cloud',
      protocolVersion: 2,
    });
    const v1Node = registerTestNode(modern.service, {
      seed: 'proto-v1',
      platformClass: 'cloud',
      protocolVersion: 1,
    });
    const requirement = {
      capabilities: [{ name: 'workflow.observe' as const }],
      placement: { required: 'cloud_required' as const },
    };
    // Both protocol versions are supported here.
    expect(modern.service.matchNodes(requirement).eligibleNodes).toHaveLength(2);

    // The narrower service over the SAME registered nodes excludes v2.
    const legacy = buildService({ keyStore, nodeStore, supportedProtocolVersions: [1] });
    const legacyResult = legacy.service.matchNodes(requirement);
    const v2Evaluation = findEvaluation(legacyResult, v2Node.nodeId);
    expect(v2Evaluation.protocolEligible).toBe(false);
    expect(v2Evaluation.eligible).toBe(false);
    expect(reasonCodes(v2Evaluation)).toEqual(['PROTOCOL_VERSION_UNSUPPORTED']);
    expect(v2Evaluation.reasons[0]?.dimension).toBe('protocol');
    expect(findEvaluation(legacyResult, v1Node.nodeId).eligible).toBe(true);
    expect(legacyResult.eligibleNodes.map((e) => e.nodeId)).toEqual([v1Node.nodeId]);
  });

  it('honors a requirement-level minimum protocol version (nodes below it are excluded)', () => {
    const { service } = buildService({ supportedProtocolVersions: [1, 2] });
    const v1Node = registerTestNode(service, { seed: 'minproto-v1', platformClass: 'cloud', protocolVersion: 1 });
    const v2Node = registerTestNode(service, { seed: 'minproto-v2', platformClass: 'cloud', protocolVersion: 2 });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'cloud_required' },
      minProtocolVersion: 2,
    });
    const v1Evaluation = findEvaluation(result, v1Node.nodeId);
    expect(v1Evaluation.protocolEligible).toBe(false);
    expect(reasonCodes(v1Evaluation)).toEqual(['PROTOCOL_VERSION_UNSUPPORTED']);
    expect(findEvaluation(result, v2Node.nodeId).eligible).toBe(true);
    expect(result.eligibleNodes.map((e) => e.nodeId)).toEqual([v2Node.nodeId]);
  });

  it('rejects a nonsensical requirement-level protocol minimum (fail closed, no silent ignore)', () => {
    const { service } = buildService();
    registerTestNode(service, { seed: 'minproto-bad', platformClass: 'cloud' });
    expect(() =>
      service.matchNodes({
        capabilities: [{ name: 'workflow.observe' }],
        placement: { required: 'any_supported_node' },
        minProtocolVersion: 0,
      }),
    ).toThrowError(/REQUIREMENT_INVALID/);
  });
});

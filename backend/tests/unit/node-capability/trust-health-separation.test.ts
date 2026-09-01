import { describe, it, expect } from 'vitest';
import { buildService, findEvaluation, reasonCodes, registerTestNode } from './helpers.js';

/**
 * V2-004 — trust and health are their OWN eligibility dimensions
 * (constitution §5: capability availability AND … AND node trust/health;
 * V2-CTRL-003: node trust is distinct from capability possession,
 * authorization, and cryptographic authenticity of execution).
 *
 * A trust or health failure must never be reported as a capability failure
 * (or vice versa): the dimension tagging is load-bearing.
 */
describe('V2-004 trust/health dimension separation', () => {
  it('a below-minimum trust tier makes the node ineligible WITHOUT touching capability eligibility', () => {
    const { service } = buildService();
    const cloud = registerTestNode(service, {
      seed: 'trust-provisional',
      platformClass: 'cloud',
      capabilities: [{ name: 'workflow.execute', version: 1, availability: 'available' }],
      trustTier: 'provisional',
    });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.execute' }],
      placement: { required: 'cloud_required' },
      minTrustTier: 'trusted',
    });
    const evaluation = findEvaluation(result, cloud.nodeId);
    expect(evaluation.trustEligible).toBe(false);
    expect(evaluation.capabilityEligible).toBe(true);
    expect(evaluation.placementEligible).toBe(true);
    expect(evaluation.healthEligible).toBe(true);
    expect(evaluation.protocolEligible).toBe(true);
    // The conjunction fails overall, but ONLY through the trust dimension.
    expect(evaluation.eligible).toBe(false);
    expect(reasonCodes(evaluation)).toEqual(['TRUST_TIER_BELOW_MINIMUM']);
    expect(evaluation.reasons[0]?.dimension).toBe('trust');
    expect(evaluation.reasons[0]?.detail).toContain('provisional');
    expect(result.eligibleNodes).toHaveLength(0);
  });

  it('trust tiers rank monotonically: trusted satisfies every minimum, untrusted satisfies none but the absent one', () => {
    const { service } = buildService();
    const trusted = registerTestNode(service, { seed: 'rank-trusted', platformClass: 'cloud', trustTier: 'trusted' });
    const provisional = registerTestNode(service, { seed: 'rank-provisional', platformClass: 'cloud', trustTier: 'provisional' });
    const untrusted = registerTestNode(service, { seed: 'rank-untrusted', platformClass: 'cloud', trustTier: 'untrusted' });
    const base = {
      capabilities: [{ name: 'workflow.observe' as const }],
      placement: { required: 'cloud_required' as const },
    };
    const atMinimum = (minTrustTier: 'untrusted' | 'provisional' | 'trusted') =>
      service.matchNodes({ ...base, minTrustTier }).eligibleNodes.map((e) => e.nodeId);

    expect(atMinimum('trusted')).toEqual([trusted.nodeId]);
    expect(atMinimum('provisional')).toEqual([provisional.nodeId, trusted.nodeId].sort());
    expect(atMinimum('untrusted')).toEqual([untrusted.nodeId, provisional.nodeId, trusted.nodeId].sort());
    // No minimum declared → every tier is eligible (trust is a CONSTRAINT the
    // requirement opts into, not a blanket default).
    expect(service.matchNodes(base).eligibleNodes).toHaveLength(3);
  });

  it('declared health below the requirement minimum is a HEALTH reason, never a capability reason', () => {
    const { service } = buildService();
    const degraded = registerTestNode(service, {
      seed: 'health-degraded',
      platformClass: 'cloud',
      attributes: { supportsHumanApproval: false, health: 'degraded' },
    });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'cloud_required' },
      minNodeHealth: 'healthy',
    });
    const evaluation = findEvaluation(result, degraded.nodeId);
    expect(evaluation.healthEligible).toBe(false);
    expect(evaluation.capabilityEligible).toBe(true);
    expect(reasonCodes(evaluation)).toEqual(['HEALTH_BELOW_MINIMUM']);
    expect(evaluation.reasons[0]?.dimension).toBe('health');
  });

  it('an unhealthy node plus a stale heartbeat reports BOTH health reasons (honest full report)', () => {
    const { service, clock } = buildService();
    const cloud = registerTestNode(service, {
      seed: 'health-unhealthy-stale',
      platformClass: 'cloud',
      attributes: { supportsHumanApproval: false, health: 'unhealthy' },
    });
    clock.advance(61_000);
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'cloud_required' },
    });
    const evaluation = findEvaluation(result, cloud.nodeId);
    // No explicit health minimum was required, but the default floor
    // (`degraded`) still excludes a node that declared itself unhealthy —
    // AND the liveness lease has also lapsed: both health reasons surface.
    expect([...reasonCodes(evaluation)].sort()).toEqual(['HEALTH_BELOW_MINIMUM', 'HEARTBEAT_STALE'].sort());
    expect(evaluation.healthEligible).toBe(false);
  });

  it('a requirement may explicitly admit an unhealthy node (opt-in loosening, never silent)', () => {
    const { service } = buildService();
    const cloud = registerTestNode(service, {
      seed: 'health-optin',
      platformClass: 'cloud',
      attributes: { supportsHumanApproval: false, health: 'unhealthy' },
    });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'cloud_required' },
      minNodeHealth: 'unhealthy',
    });
    expect(findEvaluation(result, cloud.nodeId).healthEligible).toBe(true);
    expect(result.eligibleNodes.map((e) => e.nodeId)).toEqual([cloud.nodeId]);
  });

  it('trust/health failures are distinguishable from capability ineligibility by dimension code', () => {
    const { service, clock } = buildService();
    const capable = registerTestNode(service, { seed: 'capable-but-mistrusted', platformClass: 'cloud', trustTier: 'untrusted' });
    const incapable = registerTestNode(service, {
      seed: 'trusted-but-incapable',
      platformClass: 'cloud',
      capabilities: [{ name: 'github.repository.read', version: 1, availability: 'available' }],
    });
    clock.advance(61_000); // both nodes go stale for the health dimension
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.execute' }],
      placement: { required: 'cloud_required' },
      minTrustTier: 'provisional',
    });
    const capableEvaluation = findEvaluation(result, capable.nodeId);
    const incapableEvaluation = findEvaluation(result, incapable.nodeId);
    // capability + trust + health all fail on `capable`, each with its own
    // dimension-tagged reason.
    expect(capableEvaluation.reasons.map((r) => `${r.dimension}:${r.code}`).sort()).toEqual(
      ['capability:CAPABILITY_NOT_ADVERTISED', 'trust:TRUST_TIER_BELOW_MINIMUM', 'health:HEARTBEAT_STALE'].sort(),
    );
    // `incapable` is trusted, so its rejection is capability + health only.
    expect(incapableEvaluation.reasons.map((r) => `${r.dimension}:${r.code}`).sort()).toEqual(
      ['capability:CAPABILITY_NOT_ADVERTISED', 'health:HEARTBEAT_STALE'].sort(),
    );
    expect(incapableEvaluation.trustEligible).toBe(true);
  });

  it('changing trust tier through the administrative plane changes eligibility deterministically', () => {
    const { service } = buildService();
    const node = registerTestNode(service, { seed: 'trust-change', platformClass: 'cloud', trustTier: 'untrusted' });
    const requirement = {
      capabilities: [{ name: 'workflow.observe' as const }],
      placement: { required: 'cloud_required' as const },
      minTrustTier: 'provisional' as const,
    };
    expect(service.matchNodes(requirement).eligibleNodes).toHaveLength(0);
    service.setNodeTrustAttributes({ nodeId: node.nodeId, trustTier: 'provisional' });
    expect(service.matchNodes(requirement).eligibleNodes.map((e) => e.nodeId)).toEqual([node.nodeId]);
    service.setNodeTrustAttributes({ nodeId: node.nodeId, trustTier: 'untrusted' });
    expect(service.matchNodes(requirement).eligibleNodes).toHaveLength(0);
  });
});

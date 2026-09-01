import { describe, it, expect } from 'vitest';
import { buildService, findEvaluation, reasonCodes, registerTestNode } from './helpers.js';

/**
 * V2-004 — capability requirement matching.
 *
 * A required capability that a node does not advertise is an EXPLICIT
 * ineligible result (constitution §5). Implementations may never silently
 * emulate, substitute, or fall back: no similar capability stands in, no
 * other node is chosen to hide the gap, and the ineligible evaluation is
 * reported with a dimension-tagged reason — not swallowed.
 */
describe('V2-004 capability requirement matching', () => {
  it('reports explicit ineligibility when a required capability is not advertised (no silent substitution)', () => {
    const { service } = buildService();
    const cloud = registerTestNode(service, {
      seed: 'cloud-github',
      platformClass: 'cloud',
      capabilities: [{ name: 'github.repository.read', version: 1, availability: 'available' }],
    });
    const result = service.matchNodes({
      capabilities: [{ name: 'github.pull_request.create' }],
      placement: { required: 'any_supported_node' },
    });
    // The node IS evaluated (explicit ineligible result, not an absence).
    const evaluation = findEvaluation(result, cloud.nodeId);
    expect(evaluation.capabilityEligible).toBe(false);
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.reasons).toHaveLength(1);
    expect(evaluation.reasons[0]?.code).toBe('CAPABILITY_NOT_ADVERTISED');
    expect(evaluation.reasons[0]?.dimension).toBe('capability');
    expect(evaluation.reasons[0]?.detail).toContain('github.pull_request.create');
    // No silent fallback: no node is selected.
    expect(result.eligibleNodes).toHaveLength(0);
  });

  it('never substitutes a similar advertised capability for the required one (no emulation)', () => {
    const { service } = buildService();
    const web = registerTestNode(service, {
      seed: 'web-observe-only',
      platformClass: 'web',
      capabilities: [{ name: 'browser.observe', version: 1, availability: 'available' }],
    });
    const result = service.matchNodes({
      capabilities: [{ name: 'browser.type' }],
      placement: { required: 'any_supported_node' },
    });
    const evaluation = findEvaluation(result, web.nodeId);
    expect(evaluation.capabilityEligible).toBe(false);
    expect(evaluation.reasons[0]?.code).toBe('CAPABILITY_NOT_ADVERTISED');
    expect(evaluation.reasons[0]?.detail).toContain('browser.type');
    expect(result.eligibleNodes).toHaveLength(0);
  });

  it('rejects a capability requirement below the advertised version (versioned capabilities)', () => {
    const { service } = buildService();
    const web = registerTestNode(service, {
      seed: 'web-navigate-v2',
      platformClass: 'web',
      capabilities: [{ name: 'browser.navigate', version: 2, availability: 'available' }],
    });
    const below = service.matchNodes({
      capabilities: [{ name: 'browser.navigate', minVersion: 3 }],
      placement: { required: 'any_supported_node' },
    });
    const evaluation = findEvaluation(below, web.nodeId);
    expect(evaluation.capabilityEligible).toBe(false);
    expect(evaluation.reasons[0]?.code).toBe('CAPABILITY_VERSION_BELOW_MINIMUM');
    expect(evaluation.reasons[0]?.detail).toContain('advertised 2');
    expect(below.eligibleNodes).toHaveLength(0);

    const exact = service.matchNodes({
      capabilities: [{ name: 'browser.navigate', minVersion: 2 }],
      placement: { required: 'any_supported_node' },
    });
    expect(findEvaluation(exact, web.nodeId).capabilityEligible).toBe(true);
    const any = service.matchNodes({
      capabilities: [{ name: 'browser.navigate' }],
      placement: { required: 'any_supported_node' },
    });
    expect(findEvaluation(any, web.nodeId).capabilityEligible).toBe(true);
  });

  it('treats an advertised-but-unavailable capability as NOT satisfying a required capability (fail closed)', () => {
    const { service } = buildService();
    const web = registerTestNode(service, {
      seed: 'web-degraded',
      platformClass: 'web',
      capabilities: [
        { name: 'browser.navigate', version: 1, availability: 'degraded' },
        { name: 'browser.observe', version: 1, availability: 'unavailable' },
      ],
    });
    const result = service.matchNodes({
      capabilities: [{ name: 'browser.navigate' }, { name: 'browser.observe' }],
      placement: { required: 'any_supported_node' },
    });
    const evaluation = findEvaluation(result, web.nodeId);
    expect(evaluation.capabilityEligible).toBe(false);
    expect(reasonCodes(evaluation)).toEqual(['CAPABILITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE']);
    expect(result.eligibleNodes).toHaveLength(0);
  });

  it('requires ALL capabilities (conjunction), reporting only the missing ones', () => {
    const { service } = buildService();
    const cloud = registerTestNode(service, {
      seed: 'cloud-mixed',
      platformClass: 'cloud',
      capabilities: [
        { name: 'workflow.execute', version: 1, availability: 'available' },
        { name: 'workflow.observe', version: 1, availability: 'available' },
      ],
    });
    const result = service.matchNodes({
      capabilities: [
        { name: 'workflow.execute' },
        { name: 'workflow.cancel' },
        { name: 'workflow.observe' },
      ],
      placement: { required: 'any_supported_node' },
    });
    const evaluation = findEvaluation(result, cloud.nodeId);
    expect(evaluation.capabilityEligible).toBe(false);
    // Reasons are collected in requirement order — deterministic.
    expect(reasonCodes(evaluation)).toEqual(['CAPABILITY_NOT_ADVERTISED']);
    expect(evaluation.reasons[0]?.detail).toContain('workflow.cancel');
    // The satisfied capabilities are NOT reported as reasons.
    expect(evaluation.reasons[0]?.detail).not.toContain('workflow.execute');
  });

  it('matches deterministically: identical inputs produce identical results', () => {
    const { service } = buildService();
    registerTestNode(service, { seed: 'det-a', platformClass: 'cloud' });
    registerTestNode(service, { seed: 'det-b', platformClass: 'web' });
    const requirement = {
      capabilities: [{ name: 'workflow.observe' as const }],
      placement: { required: 'any_supported_node' as const },
    };
    const first = service.matchNodes(requirement);
    const second = service.matchNodes(requirement);
    expect(second).toEqual(first);
    expect(first.eligibleNodes.map((e) => e.nodeId)).toEqual(
      [...first.eligibleNodes.map((e) => e.nodeId)].sort(),
    );
  });

  it('orders eligible nodes deterministically by placement rank then node id (independent of registration order)', () => {
    const forward = buildService();
    const a = registerTestNode(forward.service, { seed: 'ordered-a', platformClass: 'web' });
    const b = registerTestNode(forward.service, { seed: 'ordered-b', platformClass: 'web' });
    const c = registerTestNode(forward.service, { seed: 'ordered-c', platformClass: 'cloud' });
    const result = forward.service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] },
    });
    const rankOf = (id: string) => result.eligibleNodes.find((e) => e.nodeId === id)?.placementRank;
    expect(rankOf(a.nodeId)).toBe(0);
    expect(rankOf(b.nodeId)).toBe(0);
    expect(rankOf(c.nodeId)).toBe(1);
    const expectedDeviceFirst = [a.nodeId, b.nodeId].sort(); // id order, NOT registration order
    const order = result.eligibleNodes.map((e) => e.nodeId);
    expect(order).toEqual([...expectedDeviceFirst, c.nodeId]);

    // Re-register in the OPPOSITE order: the output order must not change.
    const reversed = buildService();
    registerTestNode(reversed.service, { seed: 'ordered-c', platformClass: 'cloud' });
    registerTestNode(reversed.service, { seed: 'ordered-b', platformClass: 'web' });
    registerTestNode(reversed.service, { seed: 'ordered-a', platformClass: 'web' });
    const result2 = reversed.service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] },
    });
    expect(result2.eligibleNodes.map((e) => e.nodeId)).toEqual(order);
  });
});

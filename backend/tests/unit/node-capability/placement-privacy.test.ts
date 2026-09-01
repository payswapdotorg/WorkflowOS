import { describe, it, expect } from 'vitest';
import { NodeCapabilityError } from '../../../src/node-capability/index.js';
import { buildService, findEvaluation, reasonCodes, registerTestNode } from './helpers.js';

/**
 * V2-004 — placement, locality, privacy, and human-approval constraints
 * (constitution §12: locality is a correctness constraint, not a performance
 * hint; §16 per-capability consent boundaries; §19 forbidden drift: never use
 * cloud execution when workflow locality forbids it).
 */
describe('V2-004 placement / locality / privacy constraints', () => {
  it('cloud_required requirement vs a device-class node → explicit ineligible (placement conflict)', () => {
    const { service } = buildService();
    const web = registerTestNode(service, { seed: 'web-cloudreq', platformClass: 'web' });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'cloud_required' },
    });
    const evaluation = findEvaluation(result, web.nodeId);
    expect(evaluation.placementEligible).toBe(false);
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.reasons[0]?.code).toBe('PLACEMENT_CLASS_MISMATCH');
    expect(evaluation.reasons[0]?.dimension).toBe('placement');
    expect(evaluation.placementRank).toBeNull();
    expect(evaluation.satisfiedPlacement).toBeNull();
    expect(result.eligibleNodes).toHaveLength(0);
  });

  it('device_local requirement vs a cloud node → explicit ineligible (locality correctness)', () => {
    const { service } = buildService();
    const cloud = registerTestNode(service, { seed: 'cloud-devloc', platformClass: 'cloud' });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'device_local' },
    });
    const evaluation = findEvaluation(result, cloud.nodeId);
    expect(evaluation.placementEligible).toBe(false);
    expect(evaluation.reasons[0]?.code).toBe('PLACEMENT_LOCALITY_VIOLATION');
    expect(evaluation.reasons[0]?.dimension).toBe('placement');
    // Capability possession is still honestly reported as eligible.
    expect(evaluation.capabilityEligible).toBe(true);
    expect(result.eligibleNodes).toHaveLength(0);
  });

  it('privacy local-only requirement vs a cloud node → ineligible even when the placement constraint itself would allow cloud', () => {
    const { service } = buildService();
    const cloud = registerTestNode(service, { seed: 'cloud-privacy', platformClass: 'cloud' });
    const web = registerTestNode(service, { seed: 'web-privacy', platformClass: 'web' });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'cloud_allowed' },
      privacy: { localOnly: true },
    });
    const cloudEvaluation = findEvaluation(result, cloud.nodeId);
    expect(cloudEvaluation.placementEligible).toBe(false);
    expect(reasonCodes(cloudEvaluation)).toContain('PRIVACY_LOCAL_ONLY_VIOLATION');
    expect(cloudEvaluation.capabilityEligible).toBe(true);
    const webEvaluation = findEvaluation(result, web.nodeId);
    expect(webEvaluation.eligible).toBe(true);
    expect(result.eligibleNodes.map((e) => e.nodeId)).toEqual([web.nodeId]);
  });

  it('rejects a fallback chain declared under a HARD locality constraint (no silent locality downgrade)', () => {
    const { service } = buildService();
    registerTestNode(service, { seed: 'fallback-hard', platformClass: 'cloud' });
    // device_local is a correctness constraint; falling back to cloud from it
    // would silently violate locality (constitution §12/§19) — rejected.
    expect(() =>
      service.matchNodes({
        capabilities: [{ name: 'workflow.observe' }],
        placement: { required: 'device_local', fallbackOrder: ['cloud_allowed'] },
      }),
    ).toThrowError(NodeCapabilityError);
    try {
      service.matchNodes({
        capabilities: [{ name: 'workflow.observe' }],
        placement: { required: 'device_local', fallbackOrder: ['cloud_allowed'] },
      });
    } catch (error) {
      expect((error as NodeCapabilityError).code).toBe('REQUIREMENT_INVALID');
      expect((error as NodeCapabilityError).message).toContain('device_local');
    }
    // cloud_required is equally hard.
    expect(() =>
      service.matchNodes({
        capabilities: [{ name: 'workflow.observe' }],
        placement: { required: 'cloud_required', fallbackOrder: ['any_supported_node'] },
      }),
    ).toThrowError(/REQUIREMENT_INVALID/);
  });

  it('rejects duplicate or self-referential fallback entries (deterministic chain, no repeats)', () => {
    const { service } = buildService();
    registerTestNode(service, { seed: 'fallback-dup', platformClass: 'web' });
    expect(() =>
      service.matchNodes({
        capabilities: [{ name: 'workflow.observe' }],
        placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed', 'cloud_allowed'] },
      }),
    ).toThrowError(/REQUIREMENT_INVALID/);
    expect(() =>
      service.matchNodes({
        capabilities: [{ name: 'workflow.observe' }],
        placement: { required: 'device_preferred', fallbackOrder: ['device_preferred'] },
      }),
    ).toThrowError(/REQUIREMENT_INVALID/);
  });

  it('deterministic preferred/fallback ordering: device_preferred + explicit cloud fallback ranks devices first', () => {
    const { service } = buildService();
    const web = registerTestNode(service, { seed: 'pref-web', platformClass: 'web' });
    const cloud = registerTestNode(service, { seed: 'pref-cloud', platformClass: 'cloud' });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] },
    });
    const webEvaluation = findEvaluation(result, web.nodeId);
    const cloudEvaluation = findEvaluation(result, cloud.nodeId);
    expect(webEvaluation.satisfiedPlacement).toBe('device_preferred');
    expect(webEvaluation.placementRank).toBe(0);
    // The cloud node is admitted ONLY through the EXPLICIT declared fallback
    // (never silently) and is reported as such.
    expect(cloudEvaluation.satisfiedPlacement).toBe('cloud_allowed');
    expect(cloudEvaluation.placementRank).toBe(1);
    expect(result.eligibleNodes.map((e) => e.nodeId)).toEqual([web.nodeId, cloud.nodeId]);
  });

  it('deterministic preferred/fallback ordering: cloud_preferred + explicit device fallback ranks cloud first', () => {
    const { service } = buildService();
    const web = registerTestNode(service, { seed: 'pref2-web', platformClass: 'web' });
    const cloud = registerTestNode(service, { seed: 'pref2-cloud', platformClass: 'cloud' });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'cloud_preferred', fallbackOrder: ['cloud_allowed'] },
    });
    expect(findEvaluation(result, cloud.nodeId).satisfiedPlacement).toBe('cloud_preferred');
    expect(findEvaluation(result, cloud.nodeId).placementRank).toBe(0);
    expect(findEvaluation(result, web.nodeId).satisfiedPlacement).toBe('cloud_allowed');
    expect(findEvaluation(result, web.nodeId).placementRank).toBe(1);
    expect(result.eligibleNodes.map((e) => e.nodeId)).toEqual([cloud.nodeId, web.nodeId]);
  });

  it('a multi-entry fallback chain resolves at the FIRST satisfiable entry (deterministic order)', () => {
    const { service } = buildService();
    const cloud = registerTestNode(service, { seed: 'chain-cloud', platformClass: 'cloud' });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'device_preferred', fallbackOrder: ['device_local', 'cloud_allowed', 'any_supported_node'] },
    });
    const evaluation = findEvaluation(result, cloud.nodeId);
    expect(evaluation.placementEligible).toBe(true);
    expect(evaluation.satisfiedPlacement).toBe('cloud_allowed');
    expect(evaluation.placementRank).toBe(2); // 1 + index of cloud_allowed (entry 1)
  });

  it('human-approval requirement: only nodes declaring human-approval support are placement-eligible', () => {
    const { service } = buildService();
    const web = registerTestNode(service, {
      seed: 'human-web',
      platformClass: 'web',
      capabilities: [{ name: 'browser.observe', version: 1, availability: 'available' }],
      attributes: { supportsHumanApproval: true, health: 'healthy' },
    });
    const cloud = registerTestNode(service, {
      seed: 'human-cloud',
      platformClass: 'cloud',
      capabilities: [{ name: 'browser.observe', version: 1, availability: 'available' }],
      attributes: { supportsHumanApproval: false, health: 'healthy' },
    });
    const result = service.matchNodes({
      capabilities: [{ name: 'browser.observe' }],
      placement: { required: 'any_supported_node' },
      humanApprovalRequired: true,
    });
    const cloudEvaluation = findEvaluation(result, cloud.nodeId);
    expect(cloudEvaluation.placementEligible).toBe(false);
    expect(reasonCodes(cloudEvaluation)).toEqual(['HUMAN_APPROVAL_NOT_SUPPORTED']);
    expect(cloudEvaluation.capabilityEligible).toBe(true);
    expect(findEvaluation(result, web.nodeId).eligible).toBe(true);
    expect(result.eligibleNodes.map((e) => e.nodeId)).toEqual([web.nodeId]);
  });

  it('any_supported_node admits both device and cloud classes at the same rank', () => {
    const { service } = buildService();
    const web = registerTestNode(service, { seed: 'any-web', platformClass: 'web' });
    const cloud = registerTestNode(service, { seed: 'any-cloud', platformClass: 'cloud' });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'any_supported_node' },
    });
    expect(result.eligibleNodes.map((e) => e.placementRank)).toEqual([0, 0]);
    expect(result.eligibleNodes.map((e) => e.nodeId)).toEqual([web.nodeId, cloud.nodeId].sort());
  });

  it('collects ALL failing placement reasons honestly (never only the first dimension overall)', () => {
    const { service } = buildService();
    const cloud = registerTestNode(service, { seed: 'all-reasons', platformClass: 'cloud' });
    const result = service.matchNodes({
      capabilities: [{ name: 'browser.navigate' }],
      placement: { required: 'device_local' },
      privacy: { localOnly: true },
      humanApprovalRequired: true,
    });
    const evaluation = findEvaluation(result, cloud.nodeId);
    expect(evaluation.capabilityEligible).toBe(false);
    expect(evaluation.placementEligible).toBe(false);
    expect(reasonCodes(evaluation).sort()).toEqual(
      ['CAPABILITY_NOT_ADVERTISED', 'PLACEMENT_LOCALITY_VIOLATION', 'PRIVACY_LOCAL_ONLY_VIOLATION', 'HUMAN_APPROVAL_NOT_SUPPORTED'].sort(),
    );
    expect(evaluation.eligible).toBe(false);
    expect(result.eligibleNodes).toHaveLength(0);
  });
});

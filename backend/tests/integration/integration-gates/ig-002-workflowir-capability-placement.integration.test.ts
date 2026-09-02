/**
 * IG-002 — WorkflowIR ↔ Node Capability / Placement Integration Gate.
 *
 * Frozen scope only: V2-003 WorkflowIR remains platform-neutral while V2-004
 * resolves canonical capability and placement requirements against concrete
 * hosts. The projection from IR to NodeRequirementSet is deliberately test
 * local: V2-004 explicitly consumes requirements as data and must not absorb
 * WorkflowIR semantics.
 *
 * Unsupported-platform rejection is proven EXPLICITLY as its own proof item
 * (the frozen work order lists it separately from placement/locality/privacy
 * constraints):
 *   - platform-class-not-deployed — a device-placement workflow against a
 *     fleet that deploys no device-class node (placement-dimension-tagged,
 *     never silent);
 *   - protocol-version-unsupported — a requirement whose minimum protocol
 *     version exceeds every deployed node's protocol version (fail-closed
 *     protocol dimension gate).
 * A capability×placement conflict against a fleet that DOES deploy both
 * host classes is classified as a cross-dimensional impossibility — NOT a
 * platform rejection (each node fails a different dimension).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DefaultNodeCapabilityService,
  computeRegistrationResponse,
  type CapabilityAdvertisement,
  type NodeCapabilityService,
  type NodePlatformClass,
  type NodeRequirementSet,
} from '../../../src/node-capability/index.js';
import { buildMinimalDocument, withNode } from '../../unit/workflow-ir/helpers.js';
import {
  computeWorkflowVersionSemanticDigest,
  validateWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';

const CLOCK_BASE = 1_733_568_000_000;
const LEASE_MS = 60_000;

const CLOUD_SECRET = createHash('sha256').update('ig-002-cloud').digest();
const DEVICE_SECRET = createHash('sha256').update('ig-002-device').digest();

const CLOUD_CAPABILITIES: readonly CapabilityAdvertisement[] = [
  { name: 'workflow.execute', version: 1, availability: 'available' },
  { name: 'workflow.observe', version: 1, availability: 'available' },
  { name: 'github.repository.read', version: 1, availability: 'available' },
];

const DEVICE_CAPABILITIES: readonly CapabilityAdvertisement[] = [
  { name: 'workflow.observe', version: 1, availability: 'available' },
  { name: 'browser.navigate', version: 1, availability: 'available' },
  { name: 'browser.click', version: 1, availability: 'available' },
];

function register(
  service: NodeCapabilityService,
  secret: Uint8Array,
  platformClass: NodePlatformClass,
  capabilities: readonly CapabilityAdvertisement[],
  supportsHumanApproval: boolean,
) {
  const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
  const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
  const payload = {
    nodeKeyFingerprint,
    platformClass,
    protocolVersion: 1,
    capabilities,
    attributes: { supportsHumanApproval, health: 'healthy' as const },
  };
  const response = computeRegistrationResponse({ nodeKeySecret: secret, payload, nonce: challenge.nonce });
  const session = service.completeRegistration({
    ...payload,
    challengeNonce: challenge.nonce,
    response,
  });
  service.setNodeTrustAttributes({ nodeId: session.nodeId, trustTier: 'trusted' });
  return { ...session, nodeKeyFingerprint };
}

/** The only adapter in this gate; V2-004 receives the resulting requirement as data. */
function requirementFromIr(nodeId: string, document: WorkflowIrDocument): NodeRequirementSet {
  const node = document.ir.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`IG-002 fixture missing node ${nodeId}`);
  return {
    id: `IG-002-${node.id}`,
    capabilities: node.capabilityRequirements.map((name) => ({ name })),
    placement: { required: node.placement },
    ...(node.placement === 'device_local' ? { privacy: { localOnly: true } } : {}),
  };
}

describe('IG-002 — platform-neutral WorkflowIR capability + placement compatibility', () => {
  function buildService() {
    let now = CLOCK_BASE;
    let nonce = 0;
    const service = new DefaultNodeCapabilityService({
      clock: () => now,
      nonceSource: () => (++nonce).toString(16).padStart(16, '0'),
      heartbeatLeaseTtlMs: LEASE_MS,
    });
    const cloud = register(service, CLOUD_SECRET, 'cloud', CLOUD_CAPABILITIES, false);
    const device = register(service, DEVICE_SECRET, 'web', DEVICE_CAPABILITIES, true);
    return {
      service,
      cloud,
      device,
      advance: (ms: number) => { now += ms; },
    };
  }

  /** Cloud-only fleet: NO device-class node deployed (platform rejection). */
  function buildCloudOnlyService() {
    let now = CLOCK_BASE;
    let nonce = 0;
    const service = new DefaultNodeCapabilityService({
      clock: () => now,
      nonceSource: () => (++nonce).toString(16).padStart(16, '0'),
      heartbeatLeaseTtlMs: LEASE_MS,
    });
    const cloud = register(service, CLOUD_SECRET, 'cloud', CLOUD_CAPABILITIES, false);
    return {
      service,
      cloud,
      advance: (ms: number) => { now += ms; },
    };
  }

  it('uses only canonical IR capability names and placement ids, while preserving semantic identity', () => {
    const source = buildMinimalDocument();
    const workflow = withNode(source, 'observe', {
      spec: { class: 'deterministic_api', capability: 'workflow.observe' },
      capabilityRequirements: ['workflow.observe'],
      placement: 'cloud_allowed',
    });
    expect(validateWorkflowIrDocument(workflow).ok).toBe(true);

    const requirement = requirementFromIr('observe', workflow);
    expect(requirement.capabilities.map((capability) => capability.name)).toEqual(['workflow.observe']);
    expect(requirement.placement.required).toBe('cloud_allowed');
    expect(computeWorkflowVersionSemanticDigest(workflow).digest).toBe(
      computeWorkflowVersionSemanticDigest(
        withNode(source, 'observe', {
          spec: { class: 'deterministic_api', capability: 'workflow.observe' },
          capabilityRequirements: ['workflow.observe'],
          placement: 'cloud_allowed',
        }),
      ).digest,
    );
  });

  it('matches a shared capability on two different eligible host classes with equivalent compatibility', () => {
    const { service } = buildService();
    const workflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'workflow.observe' },
      capabilityRequirements: ['workflow.observe'],
      placement: 'any_supported_node',
    });
    const result = service.matchNodes(requirementFromIr('observe', workflow));
    expect(result.eligibleNodes).toHaveLength(2);
    expect(result.evaluations.every((evaluation) => evaluation.capabilityEligible)).toBe(true);
    expect(result.evaluations.every((evaluation) => evaluation.protocolEligible)).toBe(true);
    expect(result.evaluations.every((evaluation) => evaluation.trustEligible)).toBe(true);
  });

  it('keeps authorization distinct from capability possession', () => {
    const { service } = buildService();
    const workflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_required',
    });
    const result = service.matchNodes(requirementFromIr('observe', workflow));
    const cloud = result.evaluations.find((evaluation) => evaluation.platformClass === 'cloud');
    const device = result.evaluations.find((evaluation) => evaluation.platformClass === 'web');
    expect(cloud?.capabilityEligible).toBe(true);
    expect(device?.capabilityEligible).toBe(false);
    for (const evaluation of result.evaluations) {
      expect(evaluation).not.toHaveProperty('authorized');
      expect(evaluation).not.toHaveProperty('authorizationEligible');
    }
  });

  it('enforces placement/locality/privacy constraints and classifies a cross-dimensional capability×placement impossibility honestly (distinct from platform rejection)', () => {
    const { service } = buildService();
    // Locality/privacy half: a device-local step is eligible on the device
    // host and rejected on the cloud host with explicit, dimension-tagged
    // placement reason codes (locality + the projected privacy.localOnly
    // constraint) — reason codes are asserted, not dimension names, because
    // privacy violations are placement-dimension facts in V2-004.
    const localWorkflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'browser.navigate' },
      capabilityRequirements: ['browser.navigate'],
      placement: 'device_local',
    });
    const localRequirement = requirementFromIr('observe', localWorkflow);
    const result = service.matchNodes(localRequirement);
    const cloud = result.evaluations.find((evaluation) => evaluation.platformClass === 'cloud');
    const device = result.evaluations.find((evaluation) => evaluation.platformClass === 'web');
    expect(device?.eligible).toBe(true);
    expect(cloud?.eligible).toBe(false);
    expect(cloud?.placementEligible).toBe(false);
    expect(
      cloud?.reasons.some(
        (reason) =>
          reason.code === 'PLACEMENT_LOCALITY_VIOLATION' || reason.code === 'PRIVACY_LOCAL_ONLY_VIOLATION',
      ),
    ).toBe(true);

    // Cross-dimensional impossibility half — this is NOT a platform
    // rejection: the fleet deploys BOTH host classes and each node fails a
    // DIFFERENT dimension (the cloud node lacks the browser capability; the
    // device node violates the cloud_required placement). The workflow's
    // capability×placement combination is incompatible with the registered
    // hosts, and the matcher says so per node, per dimension — never
    // silently. The true platform-rejection proofs (no node of the required
    // platform class deployed; protocol version unsupported) live in their
    // own dedicated tests below.
    const impossibleWorkflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'browser.navigate' },
      capabilityRequirements: ['browser.navigate'],
      placement: 'cloud_required',
    });
    const impossible = service.matchNodes(requirementFromIr('observe', impossibleWorkflow));
    expect(impossible.eligibleNodes).toHaveLength(0);
    expect(impossible.evaluations.every((evaluation) => !evaluation.eligible)).toBe(true);
    const impossibleCloud = impossible.evaluations.find(
      (evaluation) => evaluation.platformClass === 'cloud',
    );
    const impossibleDevice = impossible.evaluations.find(
      (evaluation) => evaluation.platformClass === 'web',
    );
    expect(impossibleCloud?.capabilityEligible).toBe(false);
    expect(
      impossibleCloud?.reasons.some(
        (reason) => reason.dimension === 'capability' && reason.code === 'CAPABILITY_NOT_ADVERTISED',
      ),
    ).toBe(true);
    expect(impossibleDevice?.placementEligible).toBe(false);
    expect(
      impossibleDevice?.reasons.some(
        (reason) => reason.dimension === 'placement' && reason.code === 'PLACEMENT_CLASS_MISMATCH',
      ),
    ).toBe(true);
  });

  it('rejects an unsupported platform honestly — no deployed node of the required platform class (dimension-tagged, never silent)', () => {
    // Fresh cloud-only fleet: NO device-class node is deployed at all, so a
    // device-local step cannot run anywhere — the platform as deployed is
    // unsupported for this workflow. This is a platform rejection, distinct
    // from the cross-dimensional impossibility case above: here the required
    // host class itself is absent from the deployed platform set.
    const { service } = buildCloudOnlyService();
    const localWorkflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'browser.navigate' },
      capabilityRequirements: ['browser.navigate'],
      placement: 'device_local',
    });
    const result = service.matchNodes(requirementFromIr('observe', localWorkflow));
    expect(result.eligibleNodes).toHaveLength(0);
    expect(result.evaluations).toHaveLength(1);
    const cloud = result.evaluations[0];
    expect(cloud?.platformClass).toBe('cloud');
    expect(cloud?.eligible).toBe(false);
    expect(cloud?.placementEligible).toBe(false);
    // device_local is a hard locality constraint (and the adapter projects
    // privacy.localOnly with it): the only deployed node violates both —
    // the rejection is explicit, dimension-tagged, and never silent.
    expect(
      cloud?.reasons.some(
        (reason) => reason.dimension === 'placement' && reason.code === 'PLACEMENT_LOCALITY_VIOLATION',
      ),
    ).toBe(true);
    expect(
      cloud?.reasons.some(
        (reason) => reason.dimension === 'placement' && reason.code === 'PRIVACY_LOCAL_ONLY_VIOLATION',
      ),
    ).toBe(true);
    // Honest classification at the correct boundary: every reason is a
    // placement or capability dimension fact.
    expect(
      cloud?.reasons.every(
        (reason) => reason.dimension === 'placement' || reason.dimension === 'capability',
      ),
    ).toBe(true);

    // The same no-device-class-deployed platform fact expressed through a
    // non-hard device placement (device_preferred with no admitted fallback)
    // reports the placement-class-mismatch reason code: identical explicit
    // unsupported-platform rejection, different placement spelling.
    const preferredWorkflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'browser.navigate' },
      capabilityRequirements: ['browser.navigate'],
      placement: 'device_preferred',
    });
    const preferred = service.matchNodes(requirementFromIr('observe', preferredWorkflow));
    expect(preferred.eligibleNodes).toHaveLength(0);
    const preferredCloud = preferred.evaluations[0];
    expect(preferredCloud?.platformClass).toBe('cloud');
    expect(preferredCloud?.placementEligible).toBe(false);
    expect(
      preferredCloud?.reasons.some(
        (reason) => reason.dimension === 'placement' && reason.code === 'PLACEMENT_CLASS_MISMATCH',
      ),
    ).toBe(true);
    expect(
      preferredCloud?.reasons.every(
        (reason) => reason.dimension === 'placement' || reason.dimension === 'capability',
      ),
    ).toBe(true);
  });

  it('rejects a platform whose protocol version is unsupported (fail-closed protocol gate)', () => {
    // Both host classes are registered at node protocol version 1; the same
    // WorkflowIR observer step (capability present on both hosts, placement
    // satisfied by both) is projected with a requirement demanding protocol
    // version >= 2. Every deployed platform fails the gate in the protocol
    // dimension alone — fail-closed, dimension-tagged, never silently
    // downgraded to an older protocol.
    const { service } = buildService();
    const workflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'workflow.observe' },
      capabilityRequirements: ['workflow.observe'],
      placement: 'any_supported_node',
    });
    const requirement: NodeRequirementSet = {
      ...requirementFromIr('observe', workflow),
      minProtocolVersion: 2,
    };
    const result = service.matchNodes(requirement);
    expect(result.eligibleNodes).toHaveLength(0);
    expect(result.evaluations).toHaveLength(2);
    for (const evaluation of result.evaluations) {
      expect(evaluation.protocolEligible).toBe(false);
      expect(
        evaluation.reasons.some(
          (reason) => reason.dimension === 'protocol' && reason.code === 'PROTOCOL_VERSION_UNSUPPORTED',
        ),
      ).toBe(true);
      // The capability and placement are still satisfied on both hosts —
      // the protocol dimension alone rejects the deployed platforms.
      expect(evaluation.capabilityEligible).toBe(true);
      expect(evaluation.placementEligible).toBe(true);
    }
  });

  it('resolves the same WorkflowIR meaning on two host classes while keeping host-specific capability differences explicit', () => {
    const { service } = buildService();
    const workflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'workflow.observe' },
      capabilityRequirements: ['workflow.observe'],
      placement: 'any_supported_node',
    });
    const requirement = requirementFromIr('observe', workflow);
    const result = service.matchNodes(requirement);
    const views = result.evaluations.map((evaluation) => ({
      platformClass: evaluation.platformClass,
      capabilityEligible: evaluation.capabilityEligible,
      placementEligible: evaluation.placementEligible,
    }));
    expect(views).toEqual([
      expect.objectContaining({ capabilityEligible: true, placementEligible: true }),
      expect.objectContaining({ capabilityEligible: true, placementEligible: true }),
    ]);
  });
});

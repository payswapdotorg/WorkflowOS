import { createHash } from 'node:crypto';
import {
  DefaultNodeCapabilityService,
  computeRegistrationResponse,
  type CapabilityAdvertisement,
  type NodeCapabilityService,
  type NodeEligibilityEvaluation,
  type NodePlatformClass,
  type PlacementId,
  type NodeRequirementSet,
} from '../../../src/node-capability/index.js';

/**
 * V2-004 dogfooding harness — the REAL two-host capability-discovery
 * experiment.
 *
 * Registers TWO real nodes of DIFFERENT platform classes through the REAL
 * protocol path (key enrollment → nonce challenge → HMAC-SHA256
 * challenge-response → registration → heartbeats → trust attributes), then
 * resolves the SAME representative workflow-step requirement set through
 * both nodes:
 *
 *   - capabilities that exist on BOTH hosts must resolve equivalently;
 *   - capabilities absent on one host must report EXPLICIT ineligibility
 *     (honest difference reporting, constitution §13).
 *
 * Everything is deterministic (fixed injected clock, sequential nonces,
 * fixed key seeds → stable node ids) so the experiment is reproducible: the
 * same code runs as an integration test and as the standalone dogfooding
 * run (`run-two-host-dogfooding.ts`).
 */

const CLOCK_BASE = 1_733_568_000_000; // fixed injected protocol clock (ms)
const HEARTBEAT_LEASE_MS = 60_000;

const CLOUD_HOST_KEY_SEED = 'v2-004-dogfood-cloud-host-key';
const BROWSER_HOST_KEY_SEED = 'v2-004-dogfood-browser-host-key';

function hostSecret(seed: string): Uint8Array {
  return createHash('sha256').update(seed).digest();
}

const CLOUD_HOST_ADVERTISEMENT: readonly CapabilityAdvertisement[] = [
  { name: 'workflow.execute', version: 1, availability: 'available' },
  { name: 'workflow.pause', version: 1, availability: 'available' },
  { name: 'workflow.resume', version: 1, availability: 'available' },
  { name: 'workflow.cancel', version: 1, availability: 'available' },
  { name: 'workflow.observe', version: 1, availability: 'available' },
  { name: 'github.repository.read', version: 1, availability: 'available' },
  { name: 'github.pull_request.create', version: 1, availability: 'available' },
  { name: 'github.pull_request.merge', version: 1, availability: 'available' },
];

const BROWSER_HOST_ADVERTISEMENT: readonly CapabilityAdvertisement[] = [
  { name: 'browser.navigate', version: 1, availability: 'available' },
  { name: 'browser.click', version: 1, availability: 'available' },
  { name: 'browser.type', version: 1, availability: 'available' },
  { name: 'browser.observe', version: 1, availability: 'available' },
  { name: 'notifications.observe', version: 1, availability: 'available' },
  { name: 'workflow.observe', version: 1, availability: 'available' }, // genuinely shared with the cloud host
];

export interface HostNodeReport {
  readonly nodeId: string;
  readonly nodeKeyFingerprint: string;
  readonly platformClass: NodePlatformClass;
  readonly locationClass: string;
  readonly protocolVersion: number;
  readonly capabilities: readonly string[];
  readonly sessionIssued: boolean;
}

export interface PerNodeResolution {
  readonly nodeId: string;
  readonly platformClass: NodePlatformClass;
  readonly eligible: boolean;
  readonly protocolEligible: boolean;
  readonly capabilityEligible: boolean;
  readonly placementEligible: boolean;
  readonly trustEligible: boolean;
  readonly healthEligible: boolean;
  readonly satisfiedPlacement: string | null;
  readonly placementRank: number | null;
  readonly reasons: readonly { readonly dimension: string; readonly code: string; readonly detail: string }[];
}

export interface RequirementResolutionReport {
  readonly requirementId: string;
  readonly placement: { readonly required: PlacementId; readonly fallbackOrder?: readonly string[] };
  readonly requiredCapabilities: readonly string[];
  readonly perNode: readonly PerNodeResolution[];
}

export interface EquivalenceCheckReport {
  readonly requirementId: string;
  readonly sharedCapability: string;
  readonly hostA: string;
  readonly hostB: string;
  readonly equivalent: boolean;
  readonly observed: { readonly a: boolean; readonly b: boolean };
}

export interface HonestIneligibilityReport {
  readonly requirementId: string;
  readonly nodeId: string;
  readonly code: string;
  readonly detail: string;
}

export interface LivenessPhaseReport {
  readonly phase: 'registered' | 'stale' | 'heartbeat-recovered';
  readonly eligibleNodeIds: readonly string[];
}

export interface TwoHostExperimentReport {
  readonly workOrderId: 'V2-004';
  readonly protocolVersion: number;
  readonly authentication: {
    readonly mechanism: 'hmac-sha256-challenge-response';
    readonly domain: 'workflowos/node-registration/v1';
    readonly challengesExchanged: number;
    readonly sessionsIssued: number;
    readonly registrationChannelOnly: true;
  };
  readonly cloudHost: HostNodeReport;
  readonly deviceHost: HostNodeReport;
  readonly requirementResolutions: readonly RequirementResolutionReport[];
  readonly equivalenceChecks: readonly EquivalenceCheckReport[];
  readonly honestIneligibility: readonly HonestIneligibilityReport[];
  readonly livenessPhases: readonly LivenessPhaseReport[];
  readonly injectedClockBase: number;
  readonly wallClockStartedAtMs: number;
  readonly wallDurationMs: number;
}

function registerHost(
  service: NodeCapabilityService,
  secret: Uint8Array,
  platformClass: NodePlatformClass,
  capabilities: readonly CapabilityAdvertisement[],
  supportsHumanApproval: boolean,
): { nodeKeyFingerprint: string; sessionToken: string } {
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
  return { nodeKeyFingerprint, sessionToken: session.sessionToken };
}

function perNodeResolution(
  evaluation: NodeEligibilityEvaluation,
): PerNodeResolution {
  return {
    nodeId: evaluation.nodeId,
    platformClass: evaluation.platformClass,
    eligible: evaluation.eligible,
    protocolEligible: evaluation.protocolEligible,
    capabilityEligible: evaluation.capabilityEligible,
    placementEligible: evaluation.placementEligible,
    trustEligible: evaluation.trustEligible,
    healthEligible: evaluation.healthEligible,
    satisfiedPlacement: evaluation.satisfiedPlacement,
    placementRank: evaluation.placementRank,
    reasons: evaluation.reasons.map((r) => ({ dimension: r.dimension, code: r.code, detail: r.detail })),
  };
}

/** The representative workflow-step requirement sets resolved on both hosts. */
export const DOGFOODING_REQUIREMENTS: readonly NodeRequirementSet[] = [
  {
    id: 'V2-004-DOG-REQ-1-observe-run',
    capabilities: [{ name: 'workflow.observe' }],
    placement: { required: 'any_supported_node' },
  },
  {
    id: 'V2-004-DOG-REQ-2-placement-preference',
    capabilities: [{ name: 'workflow.observe' }],
    placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] },
  },
  {
    id: 'V2-004-DOG-REQ-3-open-github-pr',
    capabilities: [{ name: 'github.pull_request.create' }, { name: 'github.repository.read' }],
    placement: { required: 'cloud_required' },
  },
  {
    id: 'V2-004-DOG-REQ-4-local-browser-step',
    capabilities: [{ name: 'browser.navigate' }],
    placement: { required: 'device_local' },
    privacy: { localOnly: true },
  },
  {
    id: 'V2-004-DOG-REQ-5-local-only-privacy',
    capabilities: [{ name: 'workflow.observe' }],
    placement: { required: 'cloud_allowed' },
    privacy: { localOnly: true },
  },
];

export function runTwoHostDiscoveryExperiment(): TwoHostExperimentReport {
  const wallClockStartedAtMs = Date.now();
  let clockNow = CLOCK_BASE;
  const clock = () => clockNow;
  const advance = (ms: number) => {
    clockNow += ms;
  };

  let nonceCounter = 0;
  const nonceSource = () => {
    nonceCounter += 1;
    return nonceCounter.toString(16).padStart(16, '0');
  };

  const service = new DefaultNodeCapabilityService({
    clock,
    nonceSource,
    heartbeatLeaseTtlMs: HEARTBEAT_LEASE_MS,
  });

  // --- The two REAL hosts register through the authenticated protocol. ---
  advance(1_000);
  const cloudSecret = hostSecret(CLOUD_HOST_KEY_SEED);
  const browserSecret = hostSecret(BROWSER_HOST_KEY_SEED);
  const cloud = registerHost(service, cloudSecret, 'cloud', CLOUD_HOST_ADVERTISEMENT, false);
  advance(2_000);
  const browser = registerHost(service, browserSecret, 'web', BROWSER_HOST_ADVERTISEMENT, true);

  const cloudRecord = service.getNode(cloud.nodeKeyFingerprint);
  const browserRecord = service.getNode(browser.nodeKeyFingerprint);
  if (!cloudRecord || !browserRecord) {
    throw new Error('dogfooding harness: host registration failed');
  }

  const cloudHostReport: HostNodeReport = {
    nodeId: cloudRecord.nodeId,
    nodeKeyFingerprint: cloud.nodeKeyFingerprint,
    platformClass: cloudRecord.platformClass,
    locationClass: cloudRecord.locationClass,
    protocolVersion: cloudRecord.protocolVersion,
    capabilities: cloudRecord.capabilities.map((c) => c.name),
    sessionIssued: true,
  };
  const deviceHostReport: HostNodeReport = {
    nodeId: browserRecord.nodeId,
    nodeKeyFingerprint: browser.nodeKeyFingerprint,
    platformClass: browserRecord.platformClass,
    locationClass: browserRecord.locationClass,
    protocolVersion: browserRecord.protocolVersion,
    capabilities: browserRecord.capabilities.map((c) => c.name),
    sessionIssued: true,
  };

  // --- Liveness phases: registered → stale → heartbeat-recovered. ---
  const livenessPhases: LivenessPhaseReport[] = [];
  const probeRequirement = DOGFOODING_REQUIREMENTS[0] as NodeRequirementSet;
  livenessPhases.push({
    phase: 'registered',
    eligibleNodeIds: service.matchNodes(probeRequirement).eligibleNodes.map((e) => e.nodeId),
  });
  advance(HEARTBEAT_LEASE_MS + 1);
  livenessPhases.push({
    phase: 'stale',
    eligibleNodeIds: service.matchNodes(probeRequirement).eligibleNodes.map((e) => e.nodeId),
  });
  service.heartbeat({ nodeId: cloud.nodeKeyFingerprint, sessionToken: cloud.sessionToken });
  service.heartbeat({ nodeId: browser.nodeKeyFingerprint, sessionToken: browser.sessionToken });
  livenessPhases.push({
    phase: 'heartbeat-recovered',
    eligibleNodeIds: service.matchNodes(probeRequirement).eligibleNodes.map((e) => e.nodeId),
  });

  // --- Resolve the same requirement set through BOTH hosts. ---
  const requirementResolutions: RequirementResolutionReport[] = [];
  const equivalenceChecks: EquivalenceCheckReport[] = [];
  const honestIneligibility: HonestIneligibilityReport[] = [];

  for (const requirement of DOGFOODING_REQUIREMENTS) {
    const result = service.matchNodes(requirement);
    const cloudEvaluation = result.evaluations.find((e) => e.nodeId === cloud.nodeKeyFingerprint);
    const browserEvaluation = result.evaluations.find((e) => e.nodeId === browser.nodeKeyFingerprint);
    if (!cloudEvaluation || !browserEvaluation) {
      throw new Error(`dogfooding harness: missing evaluation for ${requirement.id}`);
    }
    requirementResolutions.push({
      requirementId: requirement.id ?? 'unnamed',
      placement: {
        required: requirement.placement.required,
        ...(requirement.placement.fallbackOrder !== undefined
          ? { fallbackOrder: requirement.placement.fallbackOrder }
          : {}),
      },
      requiredCapabilities: requirement.capabilities.map((c) => c.name),
      perNode: [perNodeResolution(browserEvaluation), perNodeResolution(cloudEvaluation)],
    });

    for (const evaluation of [browserEvaluation, cloudEvaluation]) {
      for (const reason of evaluation.reasons) {
        honestIneligibility.push({
          requirementId: requirement.id ?? 'unnamed',
          nodeId: evaluation.nodeId,
          code: reason.code,
          detail: reason.detail,
        });
      }
    }

    // Equivalence wherever the capability genuinely exists on both hosts.
    for (const required of requirement.capabilities) {
      const onBrowser = browserRecord.capabilities.some((c) => c.name === required.name);
      const onCloud = cloudRecord.capabilities.some((c) => c.name === required.name);
      if (onBrowser && onCloud) {
        equivalenceChecks.push({
          requirementId: requirement.id ?? 'unnamed',
          sharedCapability: required.name,
          hostA: browser.nodeKeyFingerprint,
          hostB: cloud.nodeKeyFingerprint,
          equivalent:
            browserEvaluation.capabilityEligible === cloudEvaluation.capabilityEligible &&
            browserEvaluation.protocolEligible === cloudEvaluation.protocolEligible &&
            browserEvaluation.trustEligible === cloudEvaluation.trustEligible &&
            browserEvaluation.healthEligible === cloudEvaluation.healthEligible &&
            browserEvaluation.capabilityEligible === true,
          observed: {
            a: browserEvaluation.capabilityEligible,
            b: cloudEvaluation.capabilityEligible,
          },
        });
      }
    }
  }

  return {
    workOrderId: 'V2-004',
    protocolVersion: 1,
    authentication: {
      mechanism: 'hmac-sha256-challenge-response',
      domain: 'workflowos/node-registration/v1',
      challengesExchanged: 2,
      sessionsIssued: 2,
      registrationChannelOnly: true,
    },
    cloudHost: cloudHostReport,
    deviceHost: deviceHostReport,
    requirementResolutions,
    equivalenceChecks,
    honestIneligibility,
    livenessPhases,
    injectedClockBase: CLOCK_BASE,
    wallClockStartedAtMs,
    wallDurationMs: Date.now() - wallClockStartedAtMs,
  };
}

/** The report minus wall-clock bookkeeping — for determinism comparisons. */
export function deterministicReportView(report: TwoHostExperimentReport): Omit<TwoHostExperimentReport, 'wallClockStartedAtMs' | 'wallDurationMs'> {
  const { wallClockStartedAtMs: _started, wallDurationMs: _duration, ...rest } = report;
  return rest;
}

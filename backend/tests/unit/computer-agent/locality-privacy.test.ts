/**
 * V2-008 — locality/privacy regressions (constitution §12: locality is a
 * CORRECTNESS constraint, not a performance hint — fail-closed, never a
 * silent cloud fallback).
 *
 * Covers the required regressions (with a REAL DefaultNodeCapabilityService
 * and hosts registered through the REAL V2-004 protocol; the desktop (device)
 * and cloud nodes register with the SAME capability set):
 *   - an IR node with placement 'device_local' → the runtime routes to the
 *     desktop node ONLY (the step report nodeId is the desktop node; the
 *     attached cloud host receives ZERO invocations);
 *   - with ONLY the cloud host attached and a device_local step →
 *     AGENT_NO_ELIGIBLE_HOST (fail-closed — never a silent cloud fallback);
 *   - with the desktop node registered but NOT attached →
 *     AGENT_HOST_NOT_CONNECTED;
 *   - a cloud_allowed step routes deterministically (the first eligible
 *     host by (placementRank, nodeId)).
 */
import { describe, it, expect } from 'vitest';
import type {
  ComputerHostAdapter,
  HostInvocationRequest,
  HostInvocationResult,
  HostObservation,
} from '../../../src/computer-agent/index.js';
import { elementDigest, registerComputerHost } from '../../../src/computer-agent/index.js';
import {
  createAgentHarness,
  createRecordingDecider,
  freshDesktopEnvironment,
  WORKFLOW_INPUTS,
  PRINCIPAL,
  type AgentHarness,
  type ManualClock,
} from './helpers.js';

const REPORT_PATH = 'reports/summary.md';

/**
 * An inline cloud host adapter (platformClass 'cloud') registered through
 * the REAL V2-004 protocol: a minimal filesystem-shaped scripted host that
 * counts its invocations (locality assertions read the counter).
 */
function createCloudHost(options: {
  harness: AgentHarness;
  clock: ManualClock;
  keySeed: string;
}): { host: ComputerHostAdapter; nodeId: string; invocations: number } {
  const { nodeId, sessionToken } = registerComputerHost({
    nodes: options.harness.nodes,
    keySeed: options.keySeed,
    platformClass: 'cloud',
    capabilities: [
      { name: 'filesystem.read', version: 1, availability: 'available' },
      { name: 'filesystem.write', version: 1, availability: 'available' },
    ],
  });
  let observationSeq = 0;
  let nonceSeq = 0;
  let invocations = 0;
  let currentContent = 'draft-v1';
  const observationOf = (subject: string, state: string): HostObservation => {
    observationSeq += 1;
    const label = subject.slice(subject.lastIndexOf('/') + 1);
    return {
      observationId: `obs-cloud-${String(observationSeq).padStart(4, '0')}`,
      observedAt: options.clock.now(),
      subject,
      elements: [
        {
          elementId: subject,
          kind: 'file' as const,
          label,
          state,
          digest: elementDigest({ elementId: subject, kind: 'file' as const, label, state }),
        },
      ],
    };
  };
  const host: ComputerHostAdapter = {
    nodeId,
    sessionToken,
    platformClass: 'cloud',
    capabilities: [
      { name: 'filesystem.read', version: 1, availability: 'available' },
      { name: 'filesystem.write', version: 1, availability: 'available' },
    ],
    attestationSupport: { supported: false, reason: 'no-attester-key' },
    nextNonce: () => `nonce-cloud-${String(++nonceSeq).padStart(4, '0')}`,
    async invoke(_invocationId: string, request: HostInvocationRequest): Promise<HostInvocationResult> {
      invocations += 1;
      if (request.kind === 'observe') {
        return { ok: true, kind: 'observed', observation: observationOf(request.subject, currentContent), converged: false };
      }
      currentContent = 'FINAL';
      return {
        ok: true,
        kind: 'acted',
        outcome: {
          outcome: 'succeeded',
          effect: observationOf(request.grounding?.targetElementId ?? REPORT_PATH, currentContent),
          detail: 'cloud scripted write',
        },
        converged: false,
      };
    },
  };
  return { host, nodeId, get invocations() { return invocations; } };
}

/**
 * The capabilities BOTH node classes register with (the step's requirement
 * set — identical for the device and the cloud node: only the platform class
 * and placement differ, never the capability surface).
 */
const NODE_CAPABILITIES = [
  { name: 'filesystem.read', version: 1, availability: 'available' as const },
  { name: 'filesystem.write', version: 1, availability: 'available' as const },
];

/** The completing decider (observe → grounded write → verify) for any host. */
function completingDecider() {
  return createRecordingDecider((ctx) => {
    const wrote = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
    }
    if (!wrote) {
      const target = ctx.observation.elements.find((element) => element.elementId === REPORT_PATH);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: {
          observationId: ctx.observation.observationId,
          targetElementId: REPORT_PATH,
          targetDigest: target?.digest ?? '',
        },
        parameters: { path: REPORT_PATH, content: 'FINAL' },
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'filesystem.read', subject: REPORT_PATH, expect: { elementId: REPORT_PATH, state: 'FINAL' } },
      outputs: { written: true },
    };
  });
}

describe('V2-008 locality/privacy (device_local routes to the device node ONLY)', () => {
  it('a device_local step routes to the desktop node; the cloud host receives ZERO invocations', async () => {
    const harness = createAgentHarness({ placement: 'device_local' });
    const environment = freshDesktopEnvironment();
    // the device and the cloud node register with the SAME capabilities —
    // only placement/platform class separates them (locality is the ONLY
    // discriminator, never a capability asymmetry):
    const desktop = harness.attachDesktopHost({
      keySeed: 'locality-desktop',
      environment,
      capabilities: NODE_CAPABILITIES,
    });
    const cloud = createCloudHost({ harness, clock: harness.clock, keySeed: 'locality-cloud' });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [desktop.host, cloud.host],
      decider: completingDecider().decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    expect(report.state).toBe('completed');
    expect(report.steps[0]?.nodeId).toBe(desktop.nodeId);
    expect(report.steps[0]?.nodeId).not.toBe(cloud.nodeId);
    // the cloud host was attached but NEVER invoked (locality is correctness):
    expect(cloud.invocations).toBe(0);
    expect(environment.readFile(REPORT_PATH)).toBe('FINAL');
  });
});

describe('V2-008 locality/privacy (fail-closed: never a silent cloud fallback)', () => {
  it('ONLY the cloud host attached + a device_local step → AGENT_NO_ELIGIBLE_HOST', async () => {
    // this harness's node directory contains ONLY the cloud node:
    const harness = createAgentHarness({ placement: 'device_local', runId: 'run_cloud_only' });
    const cloud = createCloudHost({ harness, clock: harness.clock, keySeed: 'cloud-only-node' });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [cloud.host],
      decider: completingDecider().decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    const step = report.steps[0];
    expect(step?.outcome).toBe('failed');
    expect(step?.failure?.code).toBe('AGENT_NO_ELIGIBLE_HOST');
    expect(step?.failure?.recoverable).toBe(false);
    expect(step?.failure?.detail).toContain('device_local');
    expect(step?.nodeId).toBeNull();
    expect(report.state).toBe('failed');
    // nothing was ever invoked (no silent execution on the wrong class):
    expect(cloud.invocations).toBe(0);
    expect(harness.recorderDouble.invocationRequests).toEqual([]);
  });

  it('the desktop node registered but NOT attached → AGENT_HOST_NOT_CONNECTED', async () => {
    const harness = createAgentHarness({ placement: 'device_local' });
    const desktop = harness.attachDesktopHost({
      keySeed: 'locality-unattached',
      environment: freshDesktopEnvironment(),
      capabilities: NODE_CAPABILITIES,
    });
    const cloud = createCloudHost({ harness, clock: harness.clock, keySeed: 'unattached-cloud' });
    // the desktop node IS registered and eligible, but the drive attaches
    // only the cloud adapter:
    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [cloud.host],
      decider: completingDecider().decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    const step = report.steps[0];
    expect(step?.outcome).toBe('failed');
    expect(step?.failure?.code).toBe('AGENT_HOST_NOT_CONNECTED');
    expect(step?.failure?.detail).toContain(desktop.nodeId);
    expect(step?.nodeId).toBeNull();
    expect(report.state).toBe('failed');
    expect(cloud.invocations).toBe(0);
  });
});

describe('V2-008 locality/privacy (deterministic routing when locality allows it)', () => {
  it('a cloud_allowed step routes to the first eligible host by (placementRank, nodeId) — deterministic', async () => {
    const harness = createAgentHarness({ placement: 'cloud_allowed' });
    const desktop = harness.attachDesktopHost({
      keySeed: 'routing-desktop',
      environment: freshDesktopEnvironment(),
      capabilities: NODE_CAPABILITIES,
    });
    const cloud = createCloudHost({ harness, clock: harness.clock, keySeed: 'routing-cloud' });

    // both device and cloud satisfy cloud_allowed at placementRank 0; the
    // matcher's deterministic order is (placementRank, nodeId):
    const expectedFirstNodeId = [desktop.nodeId, cloud.nodeId].sort()[0];

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [desktop.host, cloud.host],
      decider: completingDecider().decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    expect(report.state).toBe('completed');
    expect(report.steps[0]?.nodeId).toBe(expectedFirstNodeId);
    expect(report.steps[0]?.outcome).toBe('completed');
    // exactly one host executed the step (the deterministically routed one):
    if (expectedFirstNodeId === desktop.nodeId) {
      expect(cloud.invocations).toBe(0);
    } else {
      expect(cloud.invocations).toBeGreaterThan(0);
    }
  });
});

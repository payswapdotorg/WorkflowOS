import { describe, it, expect } from 'vitest';
import {
  deterministicReportView,
  runTwoHostDiscoveryExperiment,
} from './dogfooding-two-hosts.harness.js';

/**
 * V2-004 — two-host capability discovery (integration, deterministic).
 *
 * The dogfooding harness is exercised here through the REAL protocol paths:
 * real HMAC challenge-response registration of a cloud-class host
 * (workflow.* + github.*) and a web/browser-class host (browser.* +
 * notifications.observe), real heartbeats, and the same representative
 * workflow-step requirement set resolved through both. The standalone
 * dogfooding RUN (`run-two-host-dogfooding.ts`) produces the persisted
 * evidence; this test pins the experiment's contract.
 */
describe('V2-004 two-host capability discovery experiment', () => {
  const report = runTwoHostDiscoveryExperiment();

  it('registers two authenticated real nodes of DIFFERENT platform classes', () => {
    expect(report.cloudHost.platformClass).toBe('cloud');
    expect(report.cloudHost.locationClass).toBe('cloud');
    expect(report.deviceHost.platformClass).toBe('web');
    expect(report.deviceHost.locationClass).toBe('device');
    expect(report.cloudHost.nodeId).not.toBe(report.deviceHost.nodeId);
    expect(report.cloudHost.nodeId).toMatch(/^node_[0-9a-f]{16}$/);
    expect(report.deviceHost.nodeId).toMatch(/^node_[0-9a-f]{16}$/);
    expect(report.authentication.mechanism).toBe('hmac-sha256-challenge-response');
    expect(report.authentication.challengesExchanged).toBe(2);
    expect(report.authentication.sessionsIssued).toBe(2);
    expect(report.cloudHost.capabilities).toContain('workflow.execute');
    expect(report.cloudHost.capabilities).toContain('github.pull_request.create');
    expect(report.deviceHost.capabilities).toContain('browser.navigate');
    expect(report.deviceHost.capabilities).toContain('notifications.observe');
    expect(report.deviceHost.capabilities).toContain('workflow.observe'); // the genuinely shared capability
  });

  it('resolves the shared workflow.observe capability equivalently on both hosts', () => {
    const observeChecks = report.equivalenceChecks.filter((c) => c.sharedCapability === 'workflow.observe');
    expect(observeChecks.length).toBeGreaterThanOrEqual(3);
    for (const check of observeChecks) {
      expect(check.equivalent).toBe(true);
      expect(check.observed).toEqual({ a: true, b: true });
    }
    const req1 = report.requirementResolutions.find((r) => r.requirementId === 'V2-004-DOG-REQ-1-observe-run');
    expect(req1).toBeDefined();
    expect(req1?.perNode.every((p) => p.eligible)).toBe(true);
  });

  it('orders the placement preference deterministically (device rank 0, cloud rank 1 via the explicit fallback)', () => {
    const req2 = report.requirementResolutions.find(
      (r) => r.requirementId === 'V2-004-DOG-REQ-2-placement-preference',
    );
    expect(req2?.placement.fallbackOrder).toEqual(['cloud_allowed']);
    const device = req2?.perNode.find((p) => p.platformClass === 'web');
    const cloud = req2?.perNode.find((p) => p.platformClass === 'cloud');
    expect(device?.placementRank).toBe(0);
    expect(device?.satisfiedPlacement).toBe('device_preferred');
    expect(cloud?.placementRank).toBe(1);
    expect(cloud?.satisfiedPlacement).toBe('cloud_allowed');
    expect(req2?.perNode.every((p) => p.eligible)).toBe(true);
  });

  it('reports explicit ineligibility for capabilities absent on one host (honest differences)', () => {
    const req3 = report.requirementResolutions.find((r) => r.requirementId === 'V2-004-DOG-REQ-3-open-github-pr');
    const cloud3 = req3?.perNode.find((p) => p.platformClass === 'cloud');
    const browser3 = req3?.perNode.find((p) => p.platformClass === 'web');
    expect(cloud3?.eligible).toBe(true);
    expect(browser3?.eligible).toBe(false);
    expect(browser3?.capabilityEligible).toBe(false);
    expect(browser3?.placementEligible).toBe(false);
    expect(browser3?.reasons.map((r) => r.code).sort()).toEqual([
      'CAPABILITY_NOT_ADVERTISED',
      'CAPABILITY_NOT_ADVERTISED',
      'PLACEMENT_CLASS_MISMATCH',
    ]);

    const req4 = report.requirementResolutions.find((r) => r.requirementId === 'V2-004-DOG-REQ-4-local-browser-step');
    const cloud4 = req4?.perNode.find((p) => p.platformClass === 'cloud');
    const browser4 = req4?.perNode.find((p) => p.platformClass === 'web');
    expect(browser4?.eligible).toBe(true);
    expect(cloud4?.eligible).toBe(false);
    expect(cloud4?.reasons.map((r) => r.code).sort()).toEqual([
      'CAPABILITY_NOT_ADVERTISED',
      'PLACEMENT_LOCALITY_VIOLATION',
      'PRIVACY_LOCAL_ONLY_VIOLATION',
    ]);
  });

  it('reports a privacy/locality violation distinctly from a capability gap (REQ-5)', () => {
    const req5 = report.requirementResolutions.find((r) => r.requirementId === 'V2-004-DOG-REQ-5-local-only-privacy');
    const cloud5 = req5?.perNode.find((p) => p.platformClass === 'cloud');
    const browser5 = req5?.perNode.find((p) => p.platformClass === 'web');
    // The cloud host HAS the capability…
    expect(cloud5?.capabilityEligible).toBe(true);
    // …but the local-only privacy constraint excludes it explicitly.
    expect(cloud5?.eligible).toBe(false);
    expect(cloud5?.placementEligible).toBe(false);
    expect(cloud5?.reasons.map((r) => r.code)).toEqual(['PRIVACY_LOCAL_ONLY_VIOLATION']);
    expect(browser5?.eligible).toBe(true);
  });

  it('excludes stale nodes and re-includes them after a fresh heartbeat (liveness through the real path)', () => {
    const registered = report.livenessPhases.find((p) => p.phase === 'registered');
    const stale = report.livenessPhases.find((p) => p.phase === 'stale');
    const recovered = report.livenessPhases.find((p) => p.phase === 'heartbeat-recovered');
    expect(registered?.eligibleNodeIds.length).toBe(2);
    expect(stale?.eligibleNodeIds).toEqual([]);
    expect(recovered?.eligibleNodeIds.length).toBe(2);
  });

  it('is deterministic: a second run produces the identical protocol report', () => {
    const second = runTwoHostDiscoveryExperiment();
    expect(deterministicReportView(second)).toEqual(deterministicReportView(report));
  });
});

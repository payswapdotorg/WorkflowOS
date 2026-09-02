/**
 * V2-008 — cross-host protocol conformance regressions ("same protocol, all
 * host classes": platform differences appear ONLY in the capabilities
 * offered and the platform class — never in request/response semantics;
 * constitution §4).
 *
 * Covers the required regressions for EVERY host class (web, desktop,
 * mobile adapters over their scripted environments):
 *   (a) capabilities are canonical registry names and match the frozen
 *       advertised sets (WEB_HOST_CAPABILITIES / DESKTOP_HOST_CAPABILITIES /
 *       MOBILE_HOST_CAPABILITIES, pinned against
 *       COMPUTER_AGENT_REGISTRY_VOCABULARY);
 *   (b) invoking a capability NOT advertised → HOST_CAPABILITY_NOT_SUPPORTED;
 *   (c) a malformed request (a grounding-required act without grounding) →
 *       HOST_PARAMETER_INVALID;
 *   (d) observe always fresh (same invocationId, new observationId); act
 *       idempotent per invocationId (converged on re-delivery);
 *   (e) the platform class is reported correctly;
 *   (f) the SAME request/response shape discipline: a grounded act on each
 *       host type enforces target digests (external mutation between observe
 *       and act → HOST_TARGET_CHANGED on all three).
 */
import { describe, it, expect } from 'vitest';
import {
  WebBrowserHostAdapter,
  DesktopHostAdapter,
  MobileHostAdapter,
  ScriptedBrowserEnvironment,
  ScriptedDesktopEnvironment,
  ScriptedMobileEnvironment,
  WEB_HOST_CAPABILITIES,
  DESKTOP_HOST_CAPABILITIES,
  MOBILE_HOST_CAPABILITIES,
  COMPUTER_AGENT_REGISTRY_VOCABULARY,
} from '../../../src/computer-agent/index.js';
import type {
  ComputerHostAdapter,
  HostInvocationRequest,
} from '../../../src/computer-agent/index.js';
import type { CapabilityAdvertisement } from '../../../src/node-capability/index.js';
import { createManualClock } from './helpers.js';

const CLOCK = createManualClock(1_788_264_000_000);
const NO_ATTESTATION = { supported: false as const, reason: 'no-attester-key' as const };

interface HostFixture {
  readonly name: string;
  readonly host: ComputerHostAdapter;
  readonly frozenCapabilities: readonly CapabilityAdvertisement[];
  readonly platformClass: string;
  /** a canonical capability THIS host class does NOT advertise */
  readonly unadvertisedRequest: HostInvocationRequest;
  /** a grounding-required act issued WITHOUT grounding */
  readonly malformedRequest: HostInvocationRequest;
  readonly observeRequest: HostInvocationRequest;
  /** build the grounded act from a successful observation */
  readonly actRequest: (observationId: string, targetElementId: string, targetDigest: string) => HostInvocationRequest;
  /** the id of the grounding target in a successful observation */
  readonly targetElementId: string;
  /** externally change the target between observe and act */
  readonly mutateTarget: () => void;
  /** audit: the act's real effect is observable on the environment */
  readonly effectApplied: () => boolean;
}

function createWebFixture(): HostFixture {
  const environment = new ScriptedBrowserEnvironment([
    {
      url: 'https://unit.example/form',
      elements: [
        { elementId: 'btn-submit', kind: 'button' as const, label: 'Submit', state: 'enabled' },
        { elementId: 'input-name', kind: 'input' as const, label: 'Name', state: '' },
      ],
    },
  ]);
  const host = new WebBrowserHostAdapter({
    nodeId: 'node-unit-web',
    sessionToken: 'session-unit-web',
    clock: () => CLOCK.now(),
    attestation: NO_ATTESTATION,
    environment,
  });
  return {
    name: 'web (browser)',
    host,
    frozenCapabilities: WEB_HOST_CAPABILITIES,
    platformClass: 'web',
    unadvertisedRequest: { kind: 'act', capability: 'filesystem.write', grounding: null, parameters: { path: 'x', content: 'y' } },
    malformedRequest: { kind: 'act', capability: 'browser.click', grounding: null, parameters: {} },
    observeRequest: { kind: 'observe', capability: 'browser.observe', subject: 'https://unit.example/form' },
    targetElementId: 'btn-submit',
    actRequest: (observationId, targetElementId, targetDigest) => ({
      kind: 'act',
      capability: 'browser.click',
      grounding: { observationId, targetElementId, targetDigest },
      parameters: {},
    }),
    mutateTarget: () => environment.mutateElement('btn-submit', 'externally-disabled'),
    effectApplied: () => environment.snapshot().find((element) => element.elementId === 'btn-submit')?.state === 'clicked',
  };
}

function createDesktopFixture(): HostFixture {
  const environment = new ScriptedDesktopEnvironment({
    directories: ['reports'],
    files: [{ path: 'reports/summary.md', content: 'v0' }],
  });
  const host = new DesktopHostAdapter({
    nodeId: 'node-unit-desktop',
    sessionToken: 'session-unit-desktop',
    clock: () => CLOCK.now(),
    attestation: NO_ATTESTATION,
    environment,
  });
  return {
    name: 'desktop (filesystem)',
    host,
    frozenCapabilities: DESKTOP_HOST_CAPABILITIES,
    platformClass: 'desktop',
    unadvertisedRequest: { kind: 'act', capability: 'messaging.send', grounding: null, parameters: { message: 'x' } },
    malformedRequest: { kind: 'act', capability: 'ui.click', grounding: null, parameters: {} },
    observeRequest: { kind: 'observe', capability: 'filesystem.read', subject: 'reports/summary.md' },
    targetElementId: 'reports/summary.md',
    actRequest: (observationId, targetElementId, targetDigest) => ({
      kind: 'act',
      capability: 'filesystem.write',
      grounding: { observationId, targetElementId, targetDigest },
      parameters: { path: 'reports/summary.md', content: 'A' },
    }),
    mutateTarget: () => environment.externalWrite('reports/summary.md', 'externally-raced'),
    effectApplied: () => environment.readFile('reports/summary.md') === 'A',
  };
}

function createMobileFixture(): HostFixture {
  const environment = new ScriptedMobileEnvironment({
    calls: [{ callId: 'call-1', state: 'ringing', caller: 'Alice', number: '+15550001' }],
  });
  const host = new MobileHostAdapter({
    nodeId: 'node-unit-mobile',
    sessionToken: 'session-unit-mobile',
    clock: () => CLOCK.now(),
    attestation: NO_ATTESTATION,
    environment,
  });
  return {
    name: 'mobile (phone)',
    host,
    frozenCapabilities: MOBILE_HOST_CAPABILITIES,
    platformClass: 'ios',
    unadvertisedRequest: { kind: 'act', capability: 'filesystem.write', grounding: null, parameters: { path: 'x', content: 'y' } },
    malformedRequest: { kind: 'act', capability: 'phone.call.answer', grounding: null, parameters: {} },
    observeRequest: { kind: 'observe', capability: 'phone.call.observe', subject: 'calls' },
    targetElementId: 'call-1',
    actRequest: (observationId, targetElementId, targetDigest) => ({
      kind: 'act',
      capability: 'phone.call.answer',
      grounding: { observationId, targetElementId, targetDigest },
      parameters: {},
    }),
    mutateTarget: () =>
      environment.incomingCall({ callId: 'call-1', state: 'ringing', caller: 'EXTERNAL CHANGED', number: '+15550001' }),
    effectApplied: () => environment.calls().find((call) => call.callId === 'call-1')?.state === 'active',
  };
}

const FIXTURES: { readonly label: string; readonly create: () => HostFixture }[] = [
  { label: 'WebBrowserHostAdapter', create: createWebFixture },
  { label: 'DesktopHostAdapter', create: createDesktopFixture },
  { label: 'MobileHostAdapter', create: createMobileFixture },
];

for (const { label, create } of FIXTURES) {
  describe(`V2-008 host protocol conformance (${label} — one universal protocol)`, () => {
    it('(a) advertises exactly the frozen canonical capability set (registry names verbatim)', () => {
      const fixture = create();
      const canonical = new Set<string>(COMPUTER_AGENT_REGISTRY_VOCABULARY.capabilities);
      expect(fixture.host.capabilities).toEqual(fixture.frozenCapabilities);
      for (const capability of fixture.host.capabilities) {
        expect(canonical.has(capability.name), `${capability.name} must be a canonical registry name`).toBe(true);
        expect(capability.availability).toBe('available');
      }
      // the three frozen sets are distinct per host class (platform
      // differences appear ONLY here — never in protocol semantics)
      const names = (set: readonly CapabilityAdvertisement[]) => new Set(set.map((capability) => capability.name));
      expect(names(WEB_HOST_CAPABILITIES)).not.toEqual(names(DESKTOP_HOST_CAPABILITIES));
      expect(names(DESKTOP_HOST_CAPABILITIES)).not.toEqual(names(MOBILE_HOST_CAPABILITIES));
    });

    it('(b) rejects a canonical capability it does NOT advertise (HOST_CAPABILITY_NOT_SUPPORTED)', async () => {
      const fixture = create();
      const result = await fixture.host.invoke('inv-unknown-capability', fixture.unadvertisedRequest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe('HOST_CAPABILITY_NOT_SUPPORTED');
        expect(result.failure.detail).toContain(fixture.unadvertisedRequest.capability);
      }
    });

    it('(c) rejects a malformed request: a grounding-required act WITHOUT grounding (HOST_PARAMETER_INVALID)', async () => {
      const fixture = create();
      const result = await fixture.host.invoke('inv-malformed', fixture.malformedRequest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe('HOST_PARAMETER_INVALID');
        expect(result.failure.detail).toContain('requires grounding');
      }
    });

    it('(d) observes ALWAYS FRESH (same invocationId → new observationId); acts are idempotent per invocationId', async () => {
      const fixture = create();
      const first = await fixture.host.invoke('inv-obs-same', fixture.observeRequest);
      const second = await fixture.host.invoke('inv-obs-same', fixture.observeRequest);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok && first.kind === 'observed' && second.kind === 'observed') {
        expect(first.observation.observationId).not.toBe(second.observation.observationId);
        expect(first.converged).toBe(false);
        expect(second.converged).toBe(false);
      }
      // the grounded act:
      const grounding = await groundingOf(fixture);
      const act = await fixture.host.invoke('inv-act-same', fixture.actRequest(grounding.observationId, fixture.targetElementId, grounding.targetDigest));
      expect(act.ok).toBe(true);
      if (act.ok) {
        expect(act.converged).toBe(false);
      }
      expect(fixture.effectApplied()).toBe(true);
      // the re-delivery of the same invocation id converges (at-most-once):
      const redelivery = await fixture.host.invoke('inv-act-same', fixture.actRequest(grounding.observationId, fixture.targetElementId, grounding.targetDigest));
      expect(redelivery.ok).toBe(true);
      if (redelivery.ok) {
        expect(redelivery.converged).toBe(true);
      }
    });

    it('(e) reports its platform class correctly', () => {
      const fixture = create();
      expect(fixture.host.platformClass).toBe(fixture.platformClass);
    });

    it('(f) enforces target digests on grounded acts: external mutation → HOST_TARGET_CHANGED (no execution)', async () => {
      const fixture = create();
      const grounding = await groundingOf(fixture);
      fixture.mutateTarget();
      const act = await fixture.host.invoke('inv-act-raced', fixture.actRequest(grounding.observationId, fixture.targetElementId, grounding.targetDigest));
      expect(act.ok).toBe(false);
      if (!act.ok) {
        expect(act.failure.code).toBe('HOST_TARGET_CHANGED');
        expect(act.failure.actualDigest).toBeDefined();
      }
      // the mutation stands (the host did not execute the act):
      expect(fixture.effectApplied()).toBe(false);
    });
  });
}

/** Observe once through the fixture and return the grounding material. */
async function groundingOf(fixture: HostFixture): Promise<{ observationId: string; targetDigest: string }> {
  const result = await fixture.host.invoke('inv-obs-grounding', fixture.observeRequest);
  expect(result.ok).toBe(true);
  if (!result.ok || result.kind !== 'observed') {
    throw new Error('expected an observation');
  }
  const target = result.observation.elements.find((element) => element.elementId === fixture.targetElementId);
  expect(target).toBeDefined();
  return { observationId: result.observation.observationId, targetDigest: target?.digest ?? '' };
}

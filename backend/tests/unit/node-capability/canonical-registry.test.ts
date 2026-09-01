import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CANONICAL_CAPABILITY_NAMES,
  CANONICAL_PLACEMENT_IDS,
  NodeCapabilityError,
} from '../../../src/node-capability/index.js';
import {
  buildService,
  registerTestNode,
} from './helpers.js';

/**
 * V2-004 — canonical capability namespace conformance (V2-CTRL-003).
 *
 * Protocol-visible capability names and placement identifiers come from the
 * canonical protocol registry ONLY. Aliases (e.g. `phone.answer_call`,
 * `messages.send`, `calls.answer`) are forbidden as alternate protocol
 * meanings: an advertisement or requirement that uses one is REJECTED
 * (fail-closed), never silently mapped onto the canonical name.
 */
describe('V2-004 canonical registry conformance', () => {
  it('rejects the non-canonical alias `phone.answer_call` at registration', () => {
    const { service } = buildService();
    expect(() =>
      registerTestNode(service, {
        seed: 'alias-phone',
        platformClass: 'android',
        capabilities: [{ name: 'phone.answer_call', version: 1, availability: 'available' }],
      }),
    ).toThrowError(NodeCapabilityError);
    try {
      registerTestNode(service, {
        seed: 'alias-phone-2',
        platformClass: 'android',
        capabilities: [{ name: 'phone.answer_call', version: 1, availability: 'available' }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(NodeCapabilityError);
      const coded = error as NodeCapabilityError;
      expect(coded.code).toBe('CAPABILITY_NAME_NOT_CANONICAL');
      expect(coded.message).toContain('phone.answer_call');
      expect(coded.message).toContain('phone.call.answer');
    }
    // Fail-closed: the invalid node was never registered.
    expect(service.listNodes()).toHaveLength(0);
  });

  it('rejects the non-canonical alias `messages.send` at registration', () => {
    const { service } = buildService();
    expect(() =>
      registerTestNode(service, {
        seed: 'alias-messages',
        platformClass: 'ios',
        capabilities: [{ name: 'messages.send', version: 1, availability: 'available' }],
      }),
    ).toThrowError(/CAPABILITY_NAME_NOT_CANONICAL|messages\.send/);
    expect(service.listNodes()).toHaveLength(0);
  });

  it('rejects the non-canonical alias `calls.answer` at registration', () => {
    const { service } = buildService();
    expect(() =>
      registerTestNode(service, {
        seed: 'alias-calls',
        platformClass: 'android',
        capabilities: [{ name: 'calls.answer', version: 1, availability: 'available' }],
      }),
    ).toThrowError(/CAPABILITY_NAME_NOT_CANONICAL|calls\.answer/);
    expect(service.listNodes()).toHaveLength(0);
  });

  it('rejects non-lowercase and whitespace-padded capability names', () => {
    const { service } = buildService();
    expect(() =>
      registerTestNode(service, {
        seed: 'case',
        platformClass: 'web',
        capabilities: [{ name: 'BROWSER.Navigate', version: 1, availability: 'available' }],
      }),
    ).toThrowError(/CAPABILITY_NAME_NOT_CANONICAL/);
    expect(() =>
      registerTestNode(service, {
        seed: 'space',
        platformClass: 'web',
        capabilities: [{ name: 'browser.navigate ', version: 1, availability: 'available' }],
      }),
    ).toThrowError(/CAPABILITY_NAME_NOT_CANONICAL/);
    expect(service.listNodes()).toHaveLength(0);
  });

  it('accepts the canonical forms the aliases were masquerading as', () => {
    const { service } = buildService();
    const node = registerTestNode(service, {
      seed: 'canonical-phone',
      platformClass: 'android',
      capabilities: [
        { name: 'phone.call.answer', version: 1, availability: 'available' },
        { name: 'messaging.send', version: 1, availability: 'available' },
      ],
    });
    expect(service.getNode(node.nodeId)?.capabilities.map((c) => c.name)).toEqual([
      'phone.call.answer',
      'messaging.send',
    ]);
  });

  it('rejects duplicate capability names within one advertisement', () => {
    const { service } = buildService();
    expect(() =>
      registerTestNode(service, {
        seed: 'dup',
        platformClass: 'web',
        capabilities: [
          { name: 'browser.navigate', version: 1, availability: 'available' },
          { name: 'browser.navigate', version: 2, availability: 'available' },
        ],
      }),
    ).toThrowError(/CAPABILITY_DUPLICATE_IN_ADVERTISEMENT/);
    expect(service.listNodes()).toHaveLength(0);
  });

  it('rejects invalid advertisement versions and availability values', () => {
    const { service } = buildService();
    expect(() =>
      registerTestNode(service, {
        seed: 'v0',
        platformClass: 'web',
        capabilities: [{ name: 'browser.navigate', version: 0, availability: 'available' }],
      }),
    ).toThrowError(/CAPABILITY_VERSION_INVALID/);
    expect(() =>
      registerTestNode(service, {
        seed: 'v-1',
        platformClass: 'web',
        capabilities: [{ name: 'browser.navigate', version: 1, availability: 'somewhat' as never }],
      }),
    ).toThrowError(/CAPABILITY_AVAILABILITY_INVALID/);
    expect(service.listNodes()).toHaveLength(0);
  });

  it('rejects non-canonical capability names in REQUIREMENTS too (no alias-side leak)', () => {
    const { service } = buildService();
    const node = registerTestNode(service, { seed: 'req-alias', platformClass: 'cloud' });
    expect(() =>
      service.matchNodes({
        capabilities: [{ name: 'messages.send' }],
        placement: { required: 'any_supported_node' },
      }),
    ).toThrowError(/REQUIREMENT_INVALID/);
    // The registered node is untouched by the invalid requirement.
    expect(service.getNode(node.nodeId)).not.toBeNull();
  });

  it('rejects non-canonical placement identifiers in requirements (registry placement ids only)', () => {
    const { service } = buildService();
    registerTestNode(service, { seed: 'placement-alias', platformClass: 'cloud' });
    expect(() =>
      service.matchNodes({
        capabilities: [{ name: 'workflow.observe' }],
        placement: { required: 'local_device' as never },
      }),
    ).toThrowError(/REQUIREMENT_INVALID/);
    expect(() =>
      service.matchNodes({
        capabilities: [{ name: 'workflow.observe' }],
        placement: { required: 'device_local', fallbackOrder: ['cloud-ok' as never] },
      }),
    ).toThrowError(/REQUIREMENT_INVALID/);
  });

  it('keeps the embedded canonical capability list in exact sync with V2-CTRL-003-protocol-registry.json', () => {
    // Read-only conformance check against the FROZEN registry artifact at the
    // repository root (V2-004 never edits it — it mirrors it).
    const registryUrl = new URL(
      '../../../../spec/architecture/v2/V2-CTRL-003-protocol-registry.json',
      import.meta.url,
    );
    const registry = JSON.parse(readFileSync(registryUrl, 'utf8')) as {
      capabilities: Record<string, string[]>;
      placement: string[];
    };
    const registryCapabilities = Object.values(registry.capabilities)
      .flat()
      .sort();
    expect([...CANONICAL_CAPABILITY_NAMES].sort()).toEqual(registryCapabilities);
    expect([...CANONICAL_PLACEMENT_IDS].sort()).toEqual([...registry.placement].sort());
  });

  it('exposes the canonical placement ids exactly as the registry freezes them', () => {
    expect([...CANONICAL_PLACEMENT_IDS].sort()).toEqual(
      [
        'device_local',
        'device_preferred',
        'cloud_allowed',
        'cloud_preferred',
        'cloud_required',
        'any_supported_node',
      ].sort(),
    );
  });
});

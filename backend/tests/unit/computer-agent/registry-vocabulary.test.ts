/**
 * V2-008 — registry conformance: the frozen V2-CTRL-003 vocabulary snapshot
 * `COMPUTER_AGENT_REGISTRY_VOCABULARY` is used VERBATIM (anti-drift), pinned
 * against the protocol-registry JSON on disk (the run-registry-vocabulary
 * pattern). The registry is FROZEN for V2-008 at activation base SHA
 * d36499cb95c6fe80a58346cfb7452b2bf75d7a28 — any widening requires a real
 * governed registry change, never a silent edit here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMPUTER_AGENT_REGISTRY_VOCABULARY } from '../../../src/computer-agent/index.js';

const REGISTRY_JSON_PATH = fileURLToPath(
  new URL('../../../../spec/architecture/v2/V2-CTRL-003-protocol-registry.json', import.meta.url),
);

const registry = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8')) as {
  capabilities: Record<string, string[]>;
  executionClasses: string[];
  placement: string[];
  assurance: string[];
  authorityRules: string[];
};

describe('V2-008 registry conformance (frozen V2-CTRL-003, no drift)', () => {
  it('pins the frozen-at activation SHA and the registry source path', () => {
    expect(COMPUTER_AGENT_REGISTRY_VOCABULARY.registryFrozenAt).toBe('d36499cb95c6fe80a58346cfb7452b2bf75d7a28');
    expect(COMPUTER_AGENT_REGISTRY_VOCABULARY.registrySource).toBe('spec/architecture/v2/V2-CTRL-003-protocol-registry.json');
  });

  it('mirrors the registry capabilities EXACTLY (flattened, sorted equality)', () => {
    const expected = Object.values(registry.capabilities).flat().sort();
    expect([...COMPUTER_AGENT_REGISTRY_VOCABULARY.capabilities].sort()).toEqual(expected);
    expect(expected.length).toBe(46);
  });

  it('mirrors the registry execution classes exactly', () => {
    expect([...COMPUTER_AGENT_REGISTRY_VOCABULARY.executionClasses]).toEqual(registry.executionClasses);
  });

  it('mirrors the registry placement ids exactly', () => {
    expect([...COMPUTER_AGENT_REGISTRY_VOCABULARY.placement]).toEqual(registry.placement);
  });

  it('mirrors the registry assurance levels exactly', () => {
    expect([...COMPUTER_AGENT_REGISTRY_VOCABULARY.assurance]).toEqual(registry.assurance);
  });

  it('mirrors the registry authority rules verbatim (the non-authority discipline)', () => {
    expect([...COMPUTER_AGENT_REGISTRY_VOCABULARY.authorityRules]).toEqual(registry.authorityRules);
    expect([...COMPUTER_AGENT_REGISTRY_VOCABULARY.authorityRules]).toContain(
      'capability-advertisement-is-not-authorization',
    );
    expect([...COMPUTER_AGENT_REGISTRY_VOCABULARY.authorityRules]).toContain(
      'command-ack-is-not-side-effect-evidence',
    );
  });

  it('NEVER claims attestation OBJECT TYPE ownership (V2-014 owns those, via its barrel)', () => {
    // the snapshot deliberately omits the registry's attestationObjectTypes —
    // those frozen identifiers are referenced only through the merged
    // execution-attestation barrel (pinned by the module-boundary battery).
    expect(COMPUTER_AGENT_REGISTRY_VOCABULARY).not.toHaveProperty('attestationObjectTypes');
    expect(JSON.stringify(COMPUTER_AGENT_REGISTRY_VOCABULARY)).not.toContain('workflowos/execution-statement/v1');
    expect(JSON.stringify(COMPUTER_AGENT_REGISTRY_VOCABULARY)).not.toContain('workflowos/execution-attestation/v1');
    expect(JSON.stringify(COMPUTER_AGENT_REGISTRY_VOCABULARY)).not.toContain('workflowos/execution-proof-graph');
  });
});

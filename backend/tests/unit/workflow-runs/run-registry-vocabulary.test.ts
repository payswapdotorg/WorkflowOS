/**
 * V2-005 — registry conformance: the frozen V2-CTRL-003 vocabulary is used
 * VERBATIM (anti-drift), pinned against the registry JSON on disk.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RUN_REGISTRY_VOCABULARY,
  RUN_EVIDENCE_CLASSES,
  RUN_EXECUTION_CLASSES,
  RUN_PROTOCOL_EVENT_NAMES,
  RUN_TIMELINE_EVENT_NAMES,
} from '../../../src/workflow-runs/index.js';

const REGISTRY_JSON_PATH = fileURLToPath(
  new URL('../../../../spec/architecture/v2/V2-CTRL-003-protocol-registry.json', import.meta.url),
);

const registry = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8')) as {
  capabilities: Record<string, string[]>;
  events: string[];
  executionClasses: string[];
  evidence: string[];
  assurance: string[];
  authorityRules: string[];
};

describe('V2-005 registry conformance (frozen V2-CTRL-003, no drift)', () => {
  it('mirrors the registry capabilities exactly (canonical capability names only)', () => {
    const expected = Object.values(registry.capabilities).flat().sort();
    expect([...RUN_REGISTRY_VOCABULARY.capabilities].sort()).toEqual(expected);
  });

  it('mirrors the registry execution classes exactly', () => {
    expect([...RUN_EXECUTION_CLASSES]).toEqual(registry.executionClasses);
    expect([...RUN_REGISTRY_VOCABULARY.executionClasses]).toEqual(registry.executionClasses);
  });

  it('mirrors the registry EVIDENCE vocabulary exactly (intent|observation|claim|verification|human_confirmation)', () => {
    expect([...RUN_EVIDENCE_CLASSES]).toEqual(registry.evidence);
    expect([...RUN_REGISTRY_VOCABULARY.evidence]).toEqual(registry.evidence);
  });

  it('uses ONLY registry event names verbatim for the protocol event subset', () => {
    // every protocol-visible event name in the module IS a registry name
    for (const name of RUN_PROTOCOL_EVENT_NAMES) {
      expect(registry.events, `event name "${name}" must be a frozen registry event`).toContain(name);
    }
    // the run lifecycle event subset is exactly present in the registry
    const runLifecycle = [
      'workflow.run.requested',
      'workflow.run.started',
      'workflow.run.paused',
      'workflow.run.resumed',
      'workflow.run.completed',
      'workflow.run.failed',
    ];
    for (const name of runLifecycle) {
      expect([...RUN_PROTOCOL_EVENT_NAMES]).toContain(name);
    }
    // step + invocation + observation/verification + attestation-verified events
    expect([...RUN_PROTOCOL_EVENT_NAMES]).toContain('workflow.step.started');
    expect([...RUN_PROTOCOL_EVENT_NAMES]).toContain('workflow.step.completed');
    expect([...RUN_PROTOCOL_EVENT_NAMES]).toContain('capability.invocation.requested');
    expect([...RUN_PROTOCOL_EVENT_NAMES]).toContain('capability.invocation.completed');
    expect([...RUN_PROTOCOL_EVENT_NAMES]).toContain('observation.recorded');
    expect([...RUN_PROTOCOL_EVENT_NAMES]).toContain('verification.completed');
    expect([...RUN_PROTOCOL_EVENT_NAMES]).toContain('execution.attestation.verified');
  });

  it('NEVER mints the absent registry event as a protocol name (no workflow.run.cancelled alias)', () => {
    // The registry defines NO cancellation event. The timeline vocabulary may
    // carry a MODULE-scoped marker for the cancellation transition, but it must
    // NOT be shaped like a registry workflow.run.* event name.
    expect(registry.events).not.toContain('workflow.run.cancelled');
    const moduleScoped = RUN_TIMELINE_EVENT_NAMES.filter((name) => !registry.events.includes(name));
    for (const name of moduleScoped) {
      expect(name, `module-scoped timeline name "${name}" must not pose as a registry event`).not.toMatch(
        /^workflow\./,
      );
      expect(name, `module-scoped timeline name "${name}" must not pose as a registry event`).not.toMatch(
        /^capability\./,
      );
      expect(name, `module-scoped timeline name "${name}" must not pose as a registry event`).not.toMatch(
        /^(observation|verification|execution)\./,
      );
    }
    expect(moduleScoped.length).toBeGreaterThan(0);
  });

  it('the module never claims attestation OBJECT TYPE ownership (V2-014 owns those)', () => {
    expect(RUN_REGISTRY_VOCABULARY).not.toHaveProperty('attestationObjectTypes');
    expect(JSON.stringify(RUN_REGISTRY_VOCABULARY)).not.toContain('workflowos/execution-proof-graph');
    expect(JSON.stringify(RUN_REGISTRY_VOCABULARY)).not.toContain('workflowos/execution-attestation/v1');
    expect(JSON.stringify(RUN_REGISTRY_VOCABULARY)).not.toContain('workflowos/execution-statement/v1');
  });

  it('mirrors the registry authority rules verbatim (the non-authority discipline)', () => {
    expect([...RUN_REGISTRY_VOCABULARY.authorityRules]).toEqual(registry.authorityRules);
    expect(RUN_REGISTRY_VOCABULARY.authorityRules).toContain('command-ack-is-not-side-effect-evidence');
    expect(RUN_REGISTRY_VOCABULARY.authorityRules).toContain('signature-is-not-automatic-execution-truth');
  });
});

/**
 * V2-009 — the frozen protocol-registry vocabulary snapshot (no-drift):
 * the module's embedded event names, placement ids and trigger types must
 * equal the registry file on disk EXACTLY (V2-CTRL-003 discipline — the same
 * battery shape as the merged modules').
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRIGGER_REGISTRY_VOCABULARY } from '../../../src/workflow-deployments/internal/registry-vocabulary.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REGISTRY_PATH = join(REPO_ROOT, 'spec', 'architecture', 'v2', 'V2-CTRL-003-protocol-registry.json');

describe('V2-009 — registry vocabulary conformance (no drift)', () => {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
    events: string[];
    placement: string[];
  };

  it('the embedded event-name set equals the registry file verbatim (no minted, no dropped)', () => {
    expect([...TRIGGER_REGISTRY_VOCABULARY.events].sort()).toEqual([...registry.events].sort());
  });

  it('the embedded placement-id set equals the registry file verbatim', () => {
    expect([...TRIGGER_REGISTRY_VOCABULARY.placement].sort()).toEqual([...registry.placement].sort());
  });

  it('the embedded trigger-type set equals the frozen RUN_TRIGGER_TYPES (consumed vocabulary)', () => {
    expect([...TRIGGER_REGISTRY_VOCABULARY.triggerTypes].sort()).toEqual(
      [
        'manual',
        'schedule',
        'webhook',
        'application_event',
        'file_event',
        'communication_event',
        'device_event',
        'social_threshold_event',
        'workflow_lifecycle_event',
      ].sort(),
    );
  });

  it('the snapshot records its frozen source (auditable provenance)', () => {
    expect(TRIGGER_REGISTRY_VOCABULARY.sourceFile).toBe('spec/architecture/v2/V2-CTRL-003-protocol-registry.json');
    expect(TRIGGER_REGISTRY_VOCABULARY.frozenAtSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

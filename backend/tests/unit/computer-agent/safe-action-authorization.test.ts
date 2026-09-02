/**
 * V2-008 — safe-action authorization regressions (constitution §5/§16).
 *
 * Covers the required regressions:
 *   - `capabilitySensitivityOf` classification over the frozen sensitive set
 *     and representative ordinary capabilities;
 *   - `isCapabilityGranted` run-scope vs step-scope (EXACT stepId match only);
 *   - `checkInvocationAuthorization` fail-closed matrix: sensitive without
 *     grant → 'sensitive-capability-ungranted'; run grant → ok; step grant
 *     for THE step → ok; step grant for another step → rejected; ordinary
 *     capability → ok without grants; non-canonical name → 'capability-not-canonical';
 *   - every name in the frozen sensitive list is a canonical registry name.
 */
import { describe, it, expect } from 'vitest';
import {
  capabilitySensitivityOf,
  sensitiveCapabilities,
  isCapabilityGranted,
  checkInvocationAuthorization,
  COMPUTER_AGENT_REGISTRY_VOCABULARY,
} from '../../../src/computer-agent/index.js';

const NO_GRANTS = { grants: [] };
const STEP = 'organize';

describe('V2-008 safe-action authorization (per-capability consent, fail-closed)', () => {
  it('classifies the frozen sensitive set as sensitive', () => {
    for (const capability of sensitiveCapabilities()) {
      expect(capabilitySensitivityOf(capability), `${capability} must be sensitive`).toBe('sensitive');
    }
  });

  it('classifies representative observation/navigation capabilities as ordinary', () => {
    const ordinary = [
      'browser.observe',
      'browser.navigate',
      'screen.observe',
      'ui.inspect',
      'application.observe',
      'application.open',
      'phone.call.observe',
      'phone.call.identify',
      'messaging.observe',
      'spreadsheet.read',
      'social.post.observe',
      'github.repository.read',
      'workflow.observe',
    ];
    for (const capability of ordinary) {
      expect(capabilitySensitivityOf(capability), `${capability} must be ordinary`).toBe('ordinary');
    }
  });

  it('the full sensitive list is canonical registry names (no invented names)', () => {
    const canonical = new Set<string>(COMPUTER_AGENT_REGISTRY_VOCABULARY.capabilities);
    const sensitive = sensitiveCapabilities();
    expect(new Set(sensitive).size).toBe(sensitive.length); // no duplicates
    for (const capability of sensitive) {
      expect(canonical.has(capability), `${capability} must be a canonical registry name`).toBe(true);
    }
    // sensitive is a strict subset of the canonical vocabulary
    expect(sensitive.length).toBeLessThan(COMPUTER_AGENT_REGISTRY_VOCABULARY.capabilities.length);
  });

  it('isCapabilityGranted honors a run-scope grant for every step', () => {
    const policy = { grants: [{ capability: 'filesystem.read', scope: 'run' as const }] };
    expect(isCapabilityGranted(policy, 'filesystem.read', 'organize')).toBe(true);
    expect(isCapabilityGranted(policy, 'filesystem.read', 'another-step')).toBe(true);
    expect(isCapabilityGranted(policy, 'filesystem.read', '')).toBe(true);
    // a run grant for one capability never covers another
    expect(isCapabilityGranted(policy, 'filesystem.write', 'organize')).toBe(false);
  });

  it('isCapabilityGranted honors a step-scope grant ONLY on the exact stepId', () => {
    const policy = { grants: [{ capability: 'filesystem.write', scope: 'step' as const, stepId: 'organize' }] };
    expect(isCapabilityGranted(policy, 'filesystem.write', 'organize')).toBe(true);
    // exact-match discipline: prefixes/suffixes of the stepId never match
    expect(isCapabilityGranted(policy, 'filesystem.write', 'organize-2')).toBe(false);
    expect(isCapabilityGranted(policy, 'filesystem.write', 'pre-organize')).toBe(false);
    expect(isCapabilityGranted(policy, 'filesystem.write', 'ORGANIZE')).toBe(false);
    expect(isCapabilityGranted(policy, 'filesystem.write', '')).toBe(false);
  });

  it('checkInvocationAuthorization: sensitive without any grant is rejected (ungranted)', () => {
    const result = checkInvocationAuthorization(NO_GRANTS, 'filesystem.write', STEP);
    expect(result).toEqual({ ok: false, reason: 'sensitive-capability-ungranted' });
  });

  it('checkInvocationAuthorization: a run-scope grant authorizes the sensitive capability', () => {
    const result = checkInvocationAuthorization(
      { grants: [{ capability: 'filesystem.write', scope: 'run' }] },
      'filesystem.write',
      STEP,
    );
    expect(result).toEqual({ ok: true });
  });

  it('checkInvocationAuthorization: a step-scope grant authorizes ONLY the exact step', () => {
    const policy = { grants: [{ capability: 'filesystem.write', scope: 'step' as const, stepId: 'organize' }] };
    expect(checkInvocationAuthorization(policy, 'filesystem.write', 'organize')).toEqual({ ok: true });
    const otherStep = checkInvocationAuthorization(policy, 'filesystem.write', 'other-step');
    expect(otherStep).toEqual({ ok: false, reason: 'sensitive-capability-ungranted' });
  });

  it('checkInvocationAuthorization: ordinary capabilities need no grant', () => {
    expect(checkInvocationAuthorization(NO_GRANTS, 'browser.observe', STEP)).toEqual({ ok: true });
    expect(checkInvocationAuthorization(NO_GRANTS, 'screen.observe', STEP)).toEqual({ ok: true });
    expect(checkInvocationAuthorization(NO_GRANTS, 'github.repository.read', STEP)).toEqual({ ok: true });
  });

  it('checkInvocationAuthorization: non-canonical names are rejected fail-closed (never classified)', () => {
    expect(checkInvocationAuthorization(NO_GRANTS, 'fs.read', STEP)).toEqual({ ok: false, reason: 'capability-not-canonical' });
    expect(checkInvocationAuthorization(NO_GRANTS, 'filesystem.read.v2', STEP)).toEqual({
      ok: false,
      reason: 'capability-not-canonical',
    });
    expect(checkInvocationAuthorization(NO_GRANTS, 'Browser.Observe', STEP)).toEqual({
      ok: false,
      reason: 'capability-not-canonical',
    });
    expect(checkInvocationAuthorization(NO_GRANTS, '', STEP)).toEqual({ ok: false, reason: 'capability-not-canonical' });
  });

  it('checkInvocationAuthorization: grants for OTHER capabilities never authorize (per-capability, not blanket)', () => {
    const policy = {
      grants: [
        { capability: 'filesystem.read', scope: 'run' as const },
        { capability: 'browser.observe', scope: 'run' as const },
      ],
    };
    expect(checkInvocationAuthorization(policy, 'messaging.send', STEP)).toEqual({
      ok: false,
      reason: 'sensitive-capability-ungranted',
    });
  });
});

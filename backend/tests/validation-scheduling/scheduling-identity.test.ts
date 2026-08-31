import { describe, it, expect } from 'vitest';

/**
 * WORK-066 — the deterministic scheduling identity: the logical identity of
 * a scheduled validation (trigger → project → journey → environment →
 * revision/release/window → scheduling decision → validation run).
 */
import { deriveSchedulingIdentity, ValidationSchedulingError } from '../../src/validation-scheduling/index.js';

describe('WORK-066 scheduling identity — determinism', () => {
  const base = {
    trigger: 'PR' as const,
    projectId: 'proj-1',
    journeyId: 'journey-1',
    environmentId: 'env-preview',
    mode: 'PRE_MERGE' as const,
    reference: 'rev-abc123',
    assurance: 'STANDARD',
  };

  it('identical inputs → byte-identical identities (no randomness, no clock)', () => {
    const a = deriveSchedulingIdentity(base);
    const b = deriveSchedulingIdentity(base);
    expect(a).toEqual(b);
    expect(a.schedulingId).toMatch(/^svs_[0-9a-f]{24}$/);
    expect(a.contentFingerprint).toMatch(/^svf_[0-9a-f]{24}$/);
    expect(a.runId).toMatch(/^svr_[0-9a-f]{12}$/);
  });

  it('a different journey → a different identity AND a different run id (one run per leg × journey)', () => {
    const a = deriveSchedulingIdentity(base);
    const b = deriveSchedulingIdentity({ ...base, journeyId: 'journey-2' });
    expect(a.schedulingId).not.toBe(b.schedulingId);
    expect(a.runId).not.toBe(b.runId);
  });

  it('a different revision (a new push) → a different identity (independent logical events)', () => {
    const a = deriveSchedulingIdentity(base);
    const b = deriveSchedulingIdentity({ ...base, reference: 'rev-def456' });
    expect(a.schedulingId).not.toBe(b.schedulingId);
  });

  it('a different project → a different identity (the tenant boundary is part of the identity)', () => {
    const a = deriveSchedulingIdentity(base);
    const b = deriveSchedulingIdentity({ ...base, projectId: 'proj-2' });
    expect(a.schedulingId).not.toBe(b.schedulingId);
  });

  it('a different mode leg (PRE_MERGE vs POST_RELEASE of the same change) → different identities', () => {
    const a = deriveSchedulingIdentity(base);
    const b = deriveSchedulingIdentity({ ...base, mode: 'POST_RELEASE' as const, reference: 'release-1' });
    expect(a.schedulingId).not.toBe(b.schedulingId);
  });

  it('the SAME identity with a DIFFERENT assurance → the same scheduling id but a different content fingerprint (the conflict detector)', () => {
    const a = deriveSchedulingIdentity(base);
    const b = deriveSchedulingIdentity({ ...base, assurance: 'CRITICAL' });
    expect(b.schedulingId).toBe(a.schedulingId);
    expect(b.contentFingerprint).not.toBe(a.contentFingerprint);
  });

  it('an empty project id → SCHEDULING_PROJECT_REQUIRED', () => {
    expect(() => deriveSchedulingIdentity({ ...base, projectId: '' })).toThrowError(ValidationSchedulingError);
  });

  it('an empty reference → SCHEDULING_REVISION_REQUIRED', () => {
    expect(() => deriveSchedulingIdentity({ ...base, reference: '' })).toThrowError(ValidationSchedulingError);
  });

  it('an empty journey id → SCHEDULING_JOURNEY_MISSING', () => {
    expect(() => deriveSchedulingIdentity({ ...base, journeyId: '' })).toThrowError(ValidationSchedulingError);
  });
});

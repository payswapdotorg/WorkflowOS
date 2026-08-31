import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the deterministic signal identity proofs.
 *
 * Proof matrix §A (signal identity): deterministic identity; the same
 * logical failure → the same identity; a different tenant/project/
 * environment/failure → a DIFFERENT identity (no accidental collapse).
 */
import { deriveSignalIdentity, deriveOccurrenceIdentity, compareOccurrences } from '../../src/engineering-signals/internal/signal-identity.js';

const IDENTITY_INPUT = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  environmentId: 'env-prod-1',
  logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-total',
};

describe('WORK-067 — the deterministic signal identity', () => {
  it('is deterministic: identical inputs → byte-identical identity (any number of calls)', () => {
    const a = deriveSignalIdentity(IDENTITY_INPUT);
    const b = deriveSignalIdentity(IDENTITY_INPUT);
    expect(a.signalId).toBe(b.signalId);
    expect(a.identityFingerprint).toBe(b.identityFingerprint);
    expect(a.signalId).toMatch(/^sig_[0-9a-f]{24}$/);
    expect(a.identityFingerprint).toMatch(/^sgf_[0-9a-f]+$/);
  });

  it('same logical failure → SAME identity (the dedup convergence key)', () => {
    const a = deriveSignalIdentity(IDENTITY_INPUT);
    const b = deriveSignalIdentity({ ...IDENTITY_INPUT });
    expect(a.signalId).toBe(b.signalId);
  });

  it('different tenant → DIFFERENT identity (no cross-tenant collapse)', () => {
    const a = deriveSignalIdentity(IDENTITY_INPUT);
    const b = deriveSignalIdentity({ ...IDENTITY_INPUT, tenantId: 'tenant-2' });
    expect(a.signalId).not.toBe(b.signalId);
    expect(a.identityFingerprint).not.toBe(b.identityFingerprint);
  });

  it('different project → DIFFERENT identity (no cross-project collapse)', () => {
    const a = deriveSignalIdentity(IDENTITY_INPUT);
    const b = deriveSignalIdentity({ ...IDENTITY_INPUT, projectId: 'project-2' });
    expect(a.signalId).not.toBe(b.signalId);
  });

  it('different environment → DIFFERENT identity (preview vs production are two signals)', () => {
    const a = deriveSignalIdentity(IDENTITY_INPUT);
    const b = deriveSignalIdentity({ ...IDENTITY_INPUT, environmentId: 'env-preview-9' });
    expect(a.signalId).not.toBe(b.signalId);
  });

  it('different logical failure → DIFFERENT identity (no failure collapse)', () => {
    const a = deriveSignalIdentity(IDENTITY_INPUT);
    const b = deriveSignalIdentity({ ...IDENTITY_INPUT, logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-shipping' });
    expect(a.signalId).not.toBe(b.signalId);
  });

  it('fail-closed: missing scope dimensions are typed rejections (never a default identity)', () => {
    expect(() => deriveSignalIdentity({ ...IDENTITY_INPUT, tenantId: '' })).toThrowError(/SIGNAL_TENANT_REQUIRED|tenant/);
    expect(() => deriveSignalIdentity({ ...IDENTITY_INPUT, projectId: '' })).toThrowError(/SIGNAL_PROJECT_REQUIRED|project/);
    expect(() => deriveSignalIdentity({ ...IDENTITY_INPUT, environmentId: '' })).toThrowError(/SIGNAL_ENVIRONMENT_REQUIRED|environment/);
    expect(() => deriveSignalIdentity({ ...IDENTITY_INPUT, logicalFailureKey: '' })).toThrowError(/SIGNAL_LOGICAL_KEY_REQUIRED|logical failure key/);
  });
});

describe('WORK-067 — the deterministic occurrence identity', () => {
  const identity = deriveSignalIdentity(IDENTITY_INPUT);

  it('re-delivery of the SAME observation (same ref + same time) → SAME occurrence id (idempotent)', () => {
    const a = deriveOccurrenceIdentity(identity, { kind: 'validation-run', ref: 'run-1' }, '2026-09-01T12:00:00Z');
    const b = deriveOccurrenceIdentity(identity, { kind: 'validation-run', ref: 'run-1' }, '2026-09-01T12:00:00Z');
    expect(a).toBe(b);
    expect(a).toMatch(/^occ_[0-9a-f]{24}$/);
  });

  it('the same logical failure at a DIFFERENT time → a DISTINCT occurrence (appended, not deduped away)', () => {
    const a = deriveOccurrenceIdentity(identity, { kind: 'validation-run', ref: 'run-1' }, '2026-09-01T12:00:00Z');
    const b = deriveOccurrenceIdentity(identity, { kind: 'validation-run', ref: 'run-2' }, '2026-09-01T15:00:00Z');
    expect(a).not.toBe(b);
  });

  it('the same time through a DIFFERENT source record → a DISTINCT occurrence (cross-source observations are distinct)', () => {
    const a = deriveOccurrenceIdentity(identity, { kind: 'validation-run', ref: 'run-1' }, '2026-09-01T12:00:00Z');
    const b = deriveOccurrenceIdentity(identity, { kind: 'ci-evidence', ref: 'row-42' }, '2026-09-01T12:00:00Z');
    expect(a).not.toBe(b);
  });
});

describe('WORK-067 — the deterministic occurrence ordering', () => {
  it('orders by (observedAt, recordedAt, occurrenceId) — no insertion-order dependence', () => {
    const early = { observedAt: '2026-09-01T10:00:00Z', recordedAt: '2026-09-01T10:00:05Z', occurrenceId: 'occ_b' };
    const late = { observedAt: '2026-09-01T11:00:00Z', recordedAt: '2026-09-01T11:00:05Z', occurrenceId: 'occ_a' };
    expect(compareOccurrences(early, late)).toBeLessThan(0);
    expect(compareOccurrences(late, early)).toBeGreaterThan(0);
    // same observedAt → recordedAt decides
    const same = { observedAt: '2026-09-01T10:00:00Z', recordedAt: '2026-09-01T10:00:05Z', occurrenceId: 'occ_a' };
    const laterRecorded = { observedAt: '2026-09-01T10:00:00Z', recordedAt: '2026-09-01T10:00:06Z', occurrenceId: 'occ_a' };
    expect(compareOccurrences(same, laterRecorded)).toBeLessThan(0);
    // identical → 0
    expect(compareOccurrences(same, { ...same })).toBe(0);
  });
});

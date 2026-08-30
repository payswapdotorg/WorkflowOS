import { describe, it, expect } from 'vitest';

/**
 * WORK-064 Task 3 — the fail-closed Environment × EffectPolicy admission
 * matrix (spec/work-orders/WORK-064.md "Effect policy (the safety
 * contract)"; spec/architecture/v1.1/validation-model.md §5–6; the
 * implementation plan's pinned matrix).
 *
 * The admission function NEVER infers permission from the caller's requested
 * policy: it inspects the environment's EXPLICIT capabilities and rejects
 * everything not explicitly authorized.
 */
import {
  describeEnvironment,
  admitEffectPolicy,
  type Environment,
  type EffectPolicy,
  type ValidationMode,
} from '../../src/continuous-validation/index.js';

// ---------------------------------------------------------------------------
// Environment fixtures (the explicit capability envelopes)
// ---------------------------------------------------------------------------

/** A PR preview deployment: preview + full non-forbidden envelope. */
const previewEnv = describeEnvironment({
  id: 'env-preview',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-preview',
});

/** An isolated sandbox: isolated + full non-forbidden envelope. */
const isolatedEnv = describeEnvironment({
  id: 'env-isolated',
  kind: 'isolated',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-sandbox',
});

/** Production accepting the production envelope only. */
const productionEnv = describeEnvironment({
  id: 'env-production',
  kind: 'production',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION'],
});

/** Production with an isolated test tenant (the rare CRITICAL sandbox). */
const productionWithTestTenantEnv = describeEnvironment({
  id: 'env-production-tenant',
  kind: 'production',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-prod-test',
});

/** A READ_ONLY-only environment (e.g. a minimal preview). */
const readOnlyEnv = describeEnvironment({
  id: 'env-read-only',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY'],
});

/** A preview with the architect-approved safe mechanism + explicit FORBIDDEN acceptance. */
const previewWithSafeMechanismEnv = describeEnvironment({
  id: 'env-preview-safe-mechanism',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'FORBIDDEN'],
  approvedSafeMechanism: true,
});

/** A preview that lists FORBIDDEN but has NO approved safe mechanism. */
const previewForbiddenWithoutMechanismEnv = describeEnvironment({
  id: 'env-preview-forbidden-no-mechanism',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'FORBIDDEN'],
  approvedSafeMechanism: false,
});

// ---------------------------------------------------------------------------
// §1 The pinned admission matrix
// ---------------------------------------------------------------------------

describe('WORK-064 effect policy — the pinned admission matrix', () => {
  it('PRE_MERGE preview/isolated admits READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION', () => {
    for (const policy of ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'] as const) {
      expect(admitEffectPolicy(previewEnv, policy, 'PRE_MERGE').admitted).toBe(true);
      expect(admitEffectPolicy(isolatedEnv, policy, 'PRE_MERGE').admitted).toBe(true);
    }
  });

  it('PRE_MERGE rejects FORBIDDEN unless the explicit approved safe mechanism exists', () => {
    expect(admitEffectPolicy(previewEnv, 'FORBIDDEN', 'PRE_MERGE')).toMatchObject({
      admitted: false,
    });
    // WITH the approved safe mechanism + explicit acceptance: admitted.
    expect(admitEffectPolicy(previewWithSafeMechanismEnv, 'FORBIDDEN', 'PRE_MERGE').admitted).toBe(
      true,
    );
    // Listed FORBIDDEN acceptance WITHOUT the approved mechanism: still rejected.
    expect(
      admitEffectPolicy(previewForbiddenWithoutMechanismEnv, 'FORBIDDEN', 'PRE_MERGE').admitted,
    ).toBe(false);
  });

  it('POST_RELEASE production admits READ_ONLY and SAFE_MUTATION only', () => {
    expect(admitEffectPolicy(productionEnv, 'READ_ONLY', 'POST_RELEASE').admitted).toBe(true);
    expect(admitEffectPolicy(productionEnv, 'SAFE_MUTATION', 'POST_RELEASE').admitted).toBe(true);
    expect(admitEffectPolicy(productionEnv, 'FORBIDDEN', 'POST_RELEASE').admitted).toBe(false);
  });

  it('POST_RELEASE ISOLATED_MUTATION requires an isolated test tenant in production', () => {
    // production WITHOUT the tenant binding does not even declare the policy.
    expect(admitEffectPolicy(productionEnv, 'ISOLATED_MUTATION', 'POST_RELEASE').admitted).toBe(
      false,
    );
    // production WITH the isolated test tenant (the rare CRITICAL sandbox):
    expect(
      admitEffectPolicy(productionWithTestTenantEnv, 'ISOLATED_MUTATION', 'POST_RELEASE').admitted,
    ).toBe(true);
  });

  it('CONTINUOUS production mirrors POST_RELEASE (READ_ONLY + SAFE_MUTATION; tenant-gated ISOLATED_MUTATION; never FORBIDDEN)', () => {
    expect(admitEffectPolicy(productionEnv, 'READ_ONLY', 'CONTINUOUS').admitted).toBe(true);
    expect(admitEffectPolicy(productionEnv, 'SAFE_MUTATION', 'CONTINUOUS').admitted).toBe(true);
    expect(admitEffectPolicy(productionEnv, 'FORBIDDEN', 'CONTINUOUS').admitted).toBe(false);
    expect(admitEffectPolicy(productionEnv, 'ISOLATED_MUTATION', 'CONTINUOUS').admitted).toBe(false);
    expect(
      admitEffectPolicy(productionWithTestTenantEnv, 'ISOLATED_MUTATION', 'CONTINUOUS').admitted,
    ).toBe(true);
  });

  it('FORBIDDEN is rejected in EVERY mode and every production shape (no mode string bypasses it)', () => {
    for (const mode of ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'] as const) {
      expect(admitEffectPolicy(productionEnv, 'FORBIDDEN', mode).admitted).toBe(false);
      expect(
        admitEffectPolicy(productionWithTestTenantEnv, 'FORBIDDEN', mode).admitted,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §2 Fail-closed discrimination (the escalation attempts)
// ---------------------------------------------------------------------------

describe('WORK-064 effect policy — fail-closed discrimination', () => {
  it('a caller cannot elevate READ_ONLY to SAFE_MUTATION against a READ_ONLY-only environment', () => {
    const decision = admitEffectPolicy(readOnlyEnv, 'SAFE_MUTATION', 'PRE_MERGE');
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain('READ_ONLY');
  });

  it('an environment that never declared ISOLATED_MUTATION rejects it even with a tenant elsewhere', () => {
    // The tenant alone does not authorize: the capability must be DECLARED.
    const env = describeEnvironment({
      id: 'env-preview-no-isolated',
      kind: 'preview',
      acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION'],
      // isolatedTenantId present but ISOLATED_MUTATION not declared:
      isolatedTenantId: 'tenant-orphan',
    });
    expect(admitEffectPolicy(env, 'ISOLATED_MUTATION', 'PRE_MERGE').admitted).toBe(false);
  });

  it('an unknown/ambiguous capability never admits (fail-closed on anything not explicit)', () => {
    // The environment constructor rejects invalid capabilities outright; the
    // admission function re-verifies membership so a foreign policy value can
    // never slip through.
    const foreignPolicy = 'SUPER_MUTATION' as unknown as EffectPolicy;
    const decision = admitEffectPolicy(previewEnv, foreignPolicy, 'PRE_MERGE');
    expect(decision.admitted).toBe(false);
  });

  it('a foreign mode string fails closed (no mode-string policy bypass)', () => {
    const foreignMode = 'PRE_LAUNCH_PARTY' as unknown as ValidationMode;
    const decision = admitEffectPolicy(previewEnv, 'READ_ONLY', foreignMode);
    expect(decision.admitted).toBe(false);
  });

  it('mode binds the environment kind: PRE_MERGE never runs against production; POST_RELEASE/CONTINUOUS never run against preview', () => {
    expect(admitEffectPolicy(productionEnv, 'READ_ONLY', 'PRE_MERGE').admitted).toBe(false);
    expect(admitEffectPolicy(previewEnv, 'READ_ONLY', 'POST_RELEASE').admitted).toBe(false);
    expect(admitEffectPolicy(previewEnv, 'READ_ONLY', 'CONTINUOUS').admitted).toBe(false);
    expect(admitEffectPolicy(isolatedEnv, 'READ_ONLY', 'POST_RELEASE').admitted).toBe(false);
  });

  it('every rejection carries a human-readable reason (auditable decisions)', () => {
    const cases: readonly [Environment, EffectPolicy, ValidationMode][] = [
      [productionEnv, 'FORBIDDEN', 'POST_RELEASE'],
      [readOnlyEnv, 'SAFE_MUTATION', 'PRE_MERGE'],
      [previewEnv, 'FORBIDDEN', 'PRE_MERGE'],
      [productionEnv, 'READ_ONLY', 'PRE_MERGE'],
    ];
    for (const [env, policy, mode] of cases) {
      const decision = admitEffectPolicy(env, policy, mode);
      expect(decision.admitted).toBe(false);
      expect(typeof decision.reason).toBe('string');
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});

/**
 * V2-009 — the delivery policy (PURE: "retry and missed-window semantics"):
 * deterministic exponential backoff (bounded, capped), missed-window
 * decisions, and policy resolution/validation.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowDeploymentError, DEFAULT_DELIVERY_POLICY } from '../../../src/workflow-deployments/index.js';
import {
  backoffDelayMs,
  resolveDeliveryPolicy,
} from '../../../src/workflow-deployments/internal/delivery-policy.js';

describe('V2-009 — deterministic backoff (retry semantics)', () => {
  const policy = resolveDeliveryPolicy({ backoffBaseMs: 60_000, backoffMaxMs: 3_600_000 });

  it('attempt n waits base · 2^(n−1) — deterministic, no randomness', () => {
    expect(backoffDelayMs(1, policy)).toBe(60_000);
    expect(backoffDelayMs(2, policy)).toBe(120_000);
    expect(backoffDelayMs(3, policy)).toBe(240_000);
    expect(backoffDelayMs(4, policy)).toBe(480_000);
  });

  it('the backoff is capped at backoffMaxMs', () => {
    expect(backoffDelayMs(8, policy)).toBe(3_600_000);
    expect(backoffDelayMs(50, policy)).toBe(3_600_000);
  });

  it('identical inputs always produce identical delays', () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const a = backoffDelayMs(attempt, policy);
      const b = backoffDelayMs(attempt, policy);
      expect(a).toBe(b);
    }
  });
});

describe('V2-009 — delivery policy resolution (defaults + validation)', () => {
  it('an absent partial resolves to the documented default policy', () => {
    expect(resolveDeliveryPolicy(undefined)).toEqual(DEFAULT_DELIVERY_POLICY);
    expect(resolveDeliveryPolicy({})).toEqual(DEFAULT_DELIVERY_POLICY);
  });

  it('a partial overrides only the supplied fields (deterministic merge)', () => {
    expect(resolveDeliveryPolicy({ maxAttempts: 3 })).toEqual({
      ...DEFAULT_DELIVERY_POLICY,
      maxAttempts: 3,
    });
  });

  it('rejects non-positive/absurd values (fail-closed, typed SUBSCRIPTION_DELIVERY_POLICY_INVALID)', () => {
    const bads: Array<Record<string, unknown>> = [
      { missWindowMs: 0 },
      { missWindowMs: -1 },
      { missedWindow: 'backfill_all' },
      { maxAttempts: 0 },
      { maxAttempts: -2 },
      { backoffBaseMs: 0 },
      { backoffBaseMs: -5 },
      { backoffMaxMs: 0 },
      { backoffMaxMs: 1 }, // below the base default → incoherent cap
      { backoffBaseMs: 5_000, backoffMaxMs: 1_000 }, // cap below base → incoherent
    ];
    for (const partial of bads) {
      try {
        resolveDeliveryPolicy(partial as never);
        expect.unreachable(`must throw for ${JSON.stringify(partial)}`);
      } catch (error) {
        expect((error as WorkflowDeploymentError).code).toBe('SUBSCRIPTION_DELIVERY_POLICY_INVALID');
      }
    }
  });

  it('accepts a coherent full policy', () => {
    const policy = resolveDeliveryPolicy({
      missWindowMs: 600_000,
      missedWindow: 'catch_up_run_now',
      maxAttempts: 4,
      backoffBaseMs: 1_000,
      backoffMaxMs: 60_000,
    });
    expect(policy).toEqual({
      missWindowMs: 600_000,
      missedWindow: 'catch_up_run_now',
      maxAttempts: 4,
      backoffBaseMs: 1_000,
      backoffMaxMs: 60_000,
    });
  });
});

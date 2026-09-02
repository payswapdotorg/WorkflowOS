/**
 * V2-009 — the delivery policy resolution (PURE): defaults, deterministic
 * merge, fail-closed validation, and the exponential backoff derivation.
 */
import {
  DEFAULT_DELIVERY_POLICY,
  WorkflowDeploymentError,
  type DeliveryPolicy,
} from '../types.js';

/**
 * Resolve a partial override against the documented default policy
 * (deterministic field merge; coherent-bounds validation, fail-closed).
 */
export function resolveDeliveryPolicy(partial?: Partial<DeliveryPolicy>): DeliveryPolicy {
  const policy: DeliveryPolicy = { ...DEFAULT_DELIVERY_POLICY, ...stripUndefined(partial) };
  assertDeliveryPolicy(policy);
  return policy;
}

function stripUndefined(partial?: Partial<DeliveryPolicy>): Partial<DeliveryPolicy> {
  if (partial === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<DeliveryPolicy>;
}

/** Coherence bounds (fail-closed, typed SUBSCRIPTION_DELIVERY_POLICY_INVALID). */
export function assertDeliveryPolicy(policy: DeliveryPolicy): void {
  if (
    !Number.isSafeInteger(policy.missWindowMs) ||
    policy.missWindowMs < 1 ||
    policy.missWindowMs > 365 * 86_400_000
  ) {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_DELIVERY_POLICY_INVALID',
      'missWindowMs must be an integer in [1ms, 365d]',
      JSON.stringify(policy.missWindowMs),
    );
  }
  if (policy.missedWindow !== 'skip' && policy.missedWindow !== 'catch_up_run_now') {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_DELIVERY_POLICY_INVALID',
      'missedWindow must be skip | catch_up_run_now',
      JSON.stringify(policy.missedWindow),
    );
  }
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 100) {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_DELIVERY_POLICY_INVALID',
      'maxAttempts must be an integer in [1, 100]',
      JSON.stringify(policy.maxAttempts),
    );
  }
  if (!Number.isSafeInteger(policy.backoffBaseMs) || policy.backoffBaseMs < 1) {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_DELIVERY_POLICY_INVALID',
      'backoffBaseMs must be a positive integer',
      JSON.stringify(policy.backoffBaseMs),
    );
  }
  if (!Number.isSafeInteger(policy.backoffMaxMs) || policy.backoffMaxMs < policy.backoffBaseMs) {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_DELIVERY_POLICY_INVALID',
      'backoffMaxMs must be an integer >= backoffBaseMs (a cap below the base is incoherent)',
      JSON.stringify(policy.backoffMaxMs),
    );
  }
}

/**
 * The deterministic retry delay after the n-th failed attempt:
 * base · 2^(n−1), capped at backoffMaxMs. Pure — no randomness.
 */
export function backoffDelayMs(attemptCount: number, policy: DeliveryPolicy): number {
  if (attemptCount < 1) return policy.backoffBaseMs;
  // Safe exponentiation: cap the shift at 40 (≈1.1e12 × base overflows cap first).
  const shift = Math.min(attemptCount - 1, 40);
  const raw = policy.backoffBaseMs * 2 ** shift;
  return Math.min(raw, policy.backoffMaxMs);
}

/**
 * The missed-window decision: is an occurrence (scheduled at, evaluated now)
 * inside the delivery window? (PURE fact — the policy application lives in
 * the engine.)
 */
export function isWithinMissWindow(scheduledAtEpochMs: number, nowEpochMs: number, policy: DeliveryPolicy): boolean {
  return nowEpochMs - scheduledAtEpochMs <= policy.missWindowMs;
}

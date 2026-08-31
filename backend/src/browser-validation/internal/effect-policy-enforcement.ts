/**
 * WORK-065 — the effect-policy enforcement gate (the load-bearing safety
 * invariant of this Work Order).
 *
 * THE CONTRACT (spec/work-orders/WORK-065.md invariant 2-3;
 * spec/architecture/v1.1/validation-model.md §9.4): the browser agent MUST
 * enforce the declared EffectPolicy at execution time, not merely trust the
 * ValidationJourney declaration. Before performing any action, the agent
 * classifies the action's effect and checks it against the run's declared
 * EffectPolicy:
 *
 *   - a READ action is admitted under every policy (READ_ONLY,
 *     SAFE_MUTATION, ISOLATED_MUTATION);
 *   - a MUTATION action is admitted under SAFE_MUTATION and
 *     ISOLATED_MUTATION only — a mutation under READ_ONLY is REJECTED before
 *     execution with a typed effect_policy_violation execution error;
 *   - a FORBIDDEN run (the journey declared EffectPolicy FORBIDDEN) rejects
 *     EVERY action before execution — the browser agent performs no
 *     forbidden actions (the architect-approved safe mechanism is the
 *     WORK-064 admission contract, NOT a browser-execution path);
 *   - an ISOLATED_MUTATION action requires the synthetic identity's tenant
 *     binding to match the environment's isolated tenant — a cross-tenant
 *     mutation is REJECTED before execution.
 *
 * Fail closed: a violation produces a typed effect_policy_violation
 * ExecutionError (recorded by the WORK-064 finalization boundary as the run's
 * outcome — never a silent pass, never a silent healthy).
 *
 * Discrimination-proven: an agent that does NOT enforce the policy (mutating
 * under a READ_ONLY declaration, or performing a FORBIDDEN action) is rejected
 * by the corresponding test, and the test FAILS when the enforcement is
 * removed (see tests/browser-validation/effect-policy-enforcement.test.ts).
 */
import type { EffectPolicy, Environment, TestIdentityBinding, ExecutionError } from '../../continuous-validation/index.js';
import type { BrowserAction } from '../types.js';
import { classifyActionEffect, describeAction } from './browser-action.js';
import { classifyNavigationTarget } from './navigation-target.js';

/** The enforcement decision (explicit, never inferred). */
export interface EffectEnforcementDecision {
  /** True when the action may execute under the run's declared policy. */
  readonly admitted: boolean;
  /** The typed execution error to record when the action is rejected. */
  readonly executionError: ExecutionError | null;
}

/**
 * Decide whether `action` may execute under `policy`, given the run's
 * identity tenant binding, the target environment, and the JOURNEY's
 * authoritative navigation-safety allowlist. Pure, deterministic,
 * side-effect free. Fail closed: every violation produces a typed
 * effect_policy_violation ExecutionError (the WORK-064 finalization boundary
 * records it as the run's outcome — never healthy).
 *
 * Evaluation order:
 *   1. FORBIDDEN policy — rejects EVERY action (the browser agent performs no
 *      forbidden actions; the architect-approved safe mechanism is the WORK-064
 *      admission contract, NOT a browser-execution path);
 *   2. navigate — the AUTHORITATIVE navigation-target safety boundary (PR #97
 *      fourth architect review correction): the agent classifies the
 *      navigation target against the JOURNEY's `readonlySafeNavigationTargets`
 *      allowlist (the WORK-064 journey authority's trusted declaration,
 *      carried on the canonical ValidationJourney record — NOT a plan field,
 *      NOT an executor input) and enforces the verified class:
 *        - `forbidden` (non-http(s) scheme, embedded userinfo) → rejected
 *          under EVERY policy before the browser is called;
 *        - `read_only_safe` (URL is in the journey's allowlist) → admitted
 *          under every non-FORBIDDEN policy (the journey authority declared
 *          it read-only-safe);
 *        - `unverified` (URL is NOT in the journey's allowlist) → rejected
 *          under READ_ONLY (no authoritative proof of safety — the executor
 *          cannot assert safety and cannot supply a declaration; the journey
 *          must declare the target read-only-safe); admitted under
 *          SAFE_MUTATION / ISOLATED_MUTATION (the run has a mutation policy,
 *          so a potentially-mutating navigation is within policy).
 *      The browser driver is NEVER called for a rejected navigation;
 *   3. read actions (extract, screenshot) — admitted under every non-FORBIDDEN
 *      policy;
 *   4. mutation actions (click, type) under READ_ONLY — rejected before
 *      execution;
 *   5. ISOLATED_MUTATION — cross-tenant mutation rejected before execution;
 *   6. SAFE_MUTATION / ISOLATED_MUTATION (with a matching tenant) — admitted.
 *
 * The `allowlist` is the JOURNEY's authoritative `readonlySafeNavigationTargets`
 * — the WORK-064 journey authority's trusted declaration of read-only-safe
 * navigation targets (the agent passes `journey.readonlySafeNavigationTargets`,
 * the canonical journey field; there is no other channel). The executor
 * CANNOT turn a per-action assertion into authoritative safety (there is no
 * per-action `targetPolicy` field on the navigate action) and CANNOT supply
 * or replace the declaration (there is no executor input field).
 *
 * The `identity` and `environment` are REQUIRED for ISOLATED_MUTATION
 * cross-tenant enforcement (defense in depth — the WORK-064 admission
 * boundary already verified the tenant match; this re-verifies before the
 * mutation executes).
 *
 * @param allowlist the journey's authoritative readonlySafeNavigationTargets
 */
export function enforceEffectPolicy(
  action: BrowserAction,
  policy: EffectPolicy,
  identity: TestIdentityBinding,
  environment: Environment,
  allowlist: readonly string[] = [],
): EffectEnforcementDecision {
  // 1. FORBIDDEN — the browser agent performs NO forbidden actions. The safe
  //    mechanism is the WORK-064 admission contract; the agent treats FORBIDDEN
  //    as a non-executable class.
  if (policy === 'FORBIDDEN') {
    return {
      admitted: false,
      executionError: {
        kind: 'effect_policy_violation',
        reason: `FORBIDDEN effect policy — the browser agent performs no forbidden actions (${describeAction(action)}; the architect-approved safe mechanism is the WORK-064 admission contract, not a browser-execution path)`,
      },
    };
  }

  // 2. navigate — the AUTHORITATIVE navigation-target safety boundary. A
  //    navigation is NOT unconditionally a read action (PR #97 architect
  //    review correction): a browser navigation can have externally observable
  //    side effects even without a DOM mutation. The agent classifies the
  //    target against the JOURNEY's authoritative allowlist (the WORK-064
  //    journey authority's trusted declaration, read from the canonical
  //    ValidationJourney record) and the run's EffectPolicy BEFORE the browser
  //    is called. The driver is NEVER called for a rejected navigation.
  if (action.kind === 'navigate') {
    const decision = classifyNavigationTarget(action.url, allowlist);
    if (decision.targetClass === 'forbidden') {
      return {
        admitted: false,
        executionError: {
          kind: 'effect_policy_violation',
          reason: `navigation target is forbidden — ${decision.reason} (the browser driver is never called for a forbidden navigation target)`,
        },
      };
    }
    if (decision.targetClass === 'unverified' && policy === 'READ_ONLY') {
      return {
        admitted: false,
        executionError: {
          kind: 'effect_policy_violation',
          reason: `navigation target is not proven read-only-safe — ${decision.reason} (a READ_ONLY run cannot perform a navigation without an authoritative safety declaration; the browser driver is never called for an unverified navigation under READ_ONLY)`,
        },
      };
    }
    // read_only_safe under READ_ONLY/SAFE_MUTATION/ISOLATED_MUTATION, OR
    // unverified under SAFE_MUTATION/ISOLATED_MUTATION (the run has a mutation
    // policy, so a potentially-mutating navigation is within policy) — admitted.
    return { admitted: true, executionError: null };
  }

  const effect = classifyActionEffect(action);

  // 3. READ actions (extract, screenshot) are admitted under every
  //    non-FORBIDDEN policy. (navigate is handled above — it is NOT
  //    unconditionally read.)
  if (effect === 'read') {
    return { admitted: true, executionError: null };
  }

  // 4. MUTATION actions (click, type) under READ_ONLY — rejected before
  //    execution.
  if (policy === 'READ_ONLY') {
    return {
      admitted: false,
      executionError: {
        kind: 'effect_policy_violation',
        reason: `mutation action ${describeAction(action)} is rejected under READ_ONLY policy (READ_ONLY observes state and performs no mutation)`,
      },
    };
  }

  // 5. ISOLATED_MUTATION — cross-tenant mutation is rejected before execution
  //    (defense in depth: the WORK-064 admission boundary already verified the
  //    tenant match; this re-verifies at execution time).
  if (policy === 'ISOLATED_MUTATION') {
    if (identity.tenantId === null || identity.tenantId === '') {
      return {
        admitted: false,
        executionError: {
          kind: 'effect_policy_violation',
          reason: `ISOLATED_MUTATION action ${describeAction(action)} requires the synthetic identity's test-tenant binding (the identity carries none)`,
        },
      };
    }
    if (
      environment.isolatedTenantId !== null &&
      identity.tenantId !== environment.isolatedTenantId
    ) {
      return {
        admitted: false,
        executionError: {
          kind: 'effect_policy_violation',
          reason: `ISOLATED_MUTATION action ${describeAction(action)} is rejected — the identity's test tenant '${identity.tenantId}' does not match the environment's isolated tenant '${environment.isolatedTenantId}' (cross-tenant isolation)`,
        },
      };
    }
  }

  // 6. SAFE_MUTATION and ISOLATED_MUTATION (with a matching tenant) admit the
  //    mutation.
  return { admitted: true, executionError: null };
}

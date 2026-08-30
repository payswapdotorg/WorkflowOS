/**
 * WORK-064 Task 3 — the fail-closed Environment × EffectPolicy admission.
 *
 * THE SAFETY CONTRACT (spec/work-orders/WORK-064.md, "Effect policy"):
 * the EffectPolicy is the load-bearing safety invariant. A synthetic run is
 * admitted only when its declared effect policy is one the target
 * Environment is EXPLICITLY authorized to accept.
 *
 * This function NEVER infers permission from the caller's requested policy:
 * it inspects the environment's explicit capabilities
 * (`acceptedPolicies` — the only source of truth) and rejects everything
 * not explicitly authorized (fail-closed).
 *
 * The pinned matrix (the implementation plan + validation-model §5–6):
 *
 *   PRE_MERGE (preview | isolated):
 *     READ_ONLY / SAFE_MUTATION / ISOLATED_MUTATION — admitted when the
 *     environment explicitly declares them (ISOLATED_MUTATION additionally
 *     requires the isolated test tenant binding — enforced at environment
 *     construction and re-verified here).
 *     FORBIDDEN — rejected UNLESS the environment explicitly accepts it AND
 *     carries the architect-approved safe mechanism.
 *
 *   POST_RELEASE / CONTINUOUS (production):
 *     READ_ONLY / SAFE_MUTATION — admitted when declared.
 *     ISOLATED_MUTATION — only with the isolated test tenant binding
 *     (the rare CRITICAL sandbox; construction-enforced, re-verified).
 *     FORBIDDEN — ALWAYS rejected, in every production shape. No mode
 *     string, no capability list, no caller request bypasses this.
 *
 * The mode binds the environment kind (validation-model §5): PRE_MERGE runs
 * against preview/isolated deployments; POST_RELEASE and CONTINUOUS run
 * against the real production deployment. A kind mismatch is rejected here
 * AND re-checked at run admission (defense in depth).
 */
import type {
  EffectPolicy,
  Environment,
  ValidationMode,
} from '../types.js';
import { VALIDATION_MODES, EFFECT_POLICIES } from '../types.js';

/** The deterministic admission decision (explicit, never inferred). */
export interface EffectPolicyDecision {
  readonly admitted: boolean;
  readonly reason: string;
}

/** The mode → environment-kind binding (validation-model §5). */
export function environmentKindValidForMode(
  environment: Environment,
  mode: ValidationMode,
): boolean {
  switch (mode) {
    case 'PRE_MERGE':
      return environment.kind === 'preview' || environment.kind === 'isolated';
    case 'POST_RELEASE':
    case 'CONTINUOUS':
      return environment.kind === 'production';
    default:
      return false;
  }
}

/**
 * Decide whether `policy` may execute against `environment` under `mode`.
 * Pure, deterministic, side-effect free. Fail-closed on every ambiguous
 * input (foreign mode/policy strings, undeclared capabilities, missing
 * tenant bindings, missing safe mechanisms).
 */
export function admitEffectPolicy(
  environment: Environment,
  policy: EffectPolicy,
  mode: ValidationMode,
): EffectPolicyDecision {
  // Fail closed on foreign mode strings — no mode-string policy bypass.
  if (!(VALIDATION_MODES as readonly string[]).includes(mode)) {
    return {
      admitted: false,
      reason: `unknown validation mode ${JSON.stringify(mode)} (accepted: ${VALIDATION_MODES.join(' | ')})`,
    };
  }
  // Fail closed on foreign policy strings.
  if (!(EFFECT_POLICIES as readonly string[]).includes(policy)) {
    return {
      admitted: false,
      reason: `unknown effect policy ${JSON.stringify(policy)} (accepted: ${EFFECT_POLICIES.join(' | ')})`,
    };
  }
  // The mode binds the environment kind.
  if (!environmentKindValidForMode(environment, mode)) {
    return {
      admitted: false,
      reason: `mode ${mode} cannot run against a ${environment.kind} environment (PRE_MERGE binds preview/isolated; POST_RELEASE and CONTINUOUS bind production)`,
    };
  }
  // The explicit capability envelope is the ONLY source of admission truth.
  if (!environment.acceptedPolicies.includes(policy)) {
    return {
      admitted: false,
      reason: `environment ${environment.id} does not accept ${policy} (accepted: ${environment.acceptedPolicies.join(', ') || 'none'})`,
    };
  }
  // Policy-specific hardening (defense in depth beyond construction).
  if (policy === 'ISOLATED_MUTATION' && (environment.isolatedTenantId === null || environment.isolatedTenantId === '')) {
    return {
      admitted: false,
      reason: `ISOLATED_MUTATION requires the isolated test tenant binding (environment ${environment.id} has none)`,
    };
  }
  if (policy === 'FORBIDDEN') {
    // FORBIDDEN is an admission policy, not a hint. Production NEVER admits
    // it; PRE_MERGE admits it only behind the architect-approved safe
    // mechanism AND explicit acceptance.
    if (mode !== 'PRE_MERGE') {
      return {
        admitted: false,
        reason: `FORBIDDEN is rejected in ${mode} (production never admits forbidden effects)`,
      };
    }
    if (environment.approvedSafeMechanism !== true) {
      return {
        admitted: false,
        reason: `FORBIDDEN requires the architect-approved safe mechanism (environment ${environment.id} has none)`,
      };
    }
    return {
      admitted: true,
      reason: `FORBIDDEN admitted behind the architect-approved safe mechanism of environment ${environment.id} (PRE_MERGE)`,
    };
  }
  return {
    admitted: true,
    reason: `${policy} admitted: environment ${environment.id} explicitly accepts it under ${mode}`,
  };
}

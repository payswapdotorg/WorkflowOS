/**
 * V2-009 — execution placement resolution (PURE parts).
 *
 * Consumes:
 *   - V2-004's PlacementConstraint/PrivacyConstraint semantics (verbatim —
 *     the satisfied-location-classes table is V2-004's documented contract);
 *   - V2-007's compiled plan (compileWorkflow — the plan's per-unit
 *     placements are the compatibility surface).
 *
 * Owns: the deployment-policy ↔ plan compatibility decision and the
 * deployment-policy → V2-004 requirement-set projection. The capability
 * dimension deliberately stays EMPTY here (constitution §5/§12): the
 * deployment-level placement is the locality/trust/privacy decision; per-step
 * capability routing is the executor's (V2-004 matcher, V2-008 runtime).
 */
import {
  WorkflowDeploymentError,
  type DeploymentPlacementPolicy,
} from '../types.js';
import type { CompiledWorkflowPlan, PlacementId } from '../../workflow-compiler/index.js';
import type { NodeRequirementSet, PlacementConstraint } from '../../node-capability/index.js';
import { PLACEMENT_IDS, type PrivacyConstraint } from '../../node-capability/index.js';

// ============================================================================
// Location classes (V2-004's documented semantics, consumed verbatim)
// ============================================================================

/** V2-004's satisfied-location classes per placement id. */
const CLASSES_OF_PLACEMENT: Readonly<Record<PlacementId, readonly ('device' | 'cloud')[]>> = {
  device_local: ['device'],
  device_preferred: ['device'],
  cloud_allowed: ['device', 'cloud'],
  cloud_preferred: ['cloud'],
  cloud_required: ['cloud'],
  any_supported_node: ['device', 'cloud'],
};

/**
 * The deployment's effective allowed location classes: the union over the
 * explicit placement chain (required + fallbackOrder), intersected with
 * {device} when privacy.localOnly (constitution §12/§16: cloud is ineligible
 * regardless of the chain).
 */
export function effectiveDeploymentLocationClasses(policy: DeploymentPlacementPolicy): ('device' | 'cloud')[] {
  const classes = new Set<'device' | 'cloud'>();
  for (const id of chainOf(policy.placement)) {
    for (const locationClass of CLASSES_OF_PLACEMENT[id]) {
      classes.add(locationClass);
    }
  }
  if (policy.privacy.localOnly) {
    return [...classes].filter((c) => c === 'device');
  }
  return [...classes];
}

function chainOf(constraint: PlacementConstraint): PlacementId[] {
  const chain = [constraint.required, ...(constraint.fallbackOrder ?? [])];
  for (const id of chain) {
    if (!PLACEMENT_IDS.includes(id)) {
      throw new WorkflowDeploymentError(
        'DEPLOYMENT_INVALID_PLACEMENT',
        'the placement chain contains a non-canonical registry placement id',
        JSON.stringify(id),
      );
    }
  }
  return chain;
}

// ============================================================================
// Deployment ↔ compiled-plan placement compatibility
// ============================================================================

export type PlacementCompatibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'DEPLOYMENT_PLAN_INCOMPATIBLE'; readonly detail: string };

/**
 * The compatibility decision: EVERY compiled unit's placement must be
 * satisfiable within the deployment's effective location classes (a unit's
 * own fallback possibilities are not representable in the compiled plan —
 * each unit carries one registry placement id, whose classes are the unit's
 * requirement). Locality is a correctness constraint (constitution §12):
 * an incompatible deployment is REJECTED at creation (typed), never silently
 * accepted to fail later at delivery.
 */
export function checkPlacementCompatibility(input: {
  readonly policy: DeploymentPlacementPolicy;
  readonly plan: CompiledWorkflowPlan;
}): PlacementCompatibility {
  const allowed = new Set(effectiveDeploymentLocationClasses(input.policy));
  if (allowed.size === 0) {
    return {
      ok: false,
      code: 'DEPLOYMENT_PLAN_INCOMPATIBLE',
      detail: 'the placement policy allows NO location class (localOnly with a cloud-only chain) — no plan is deployable on it',
    };
  }
  for (const unit of input.plan.units) {
    const unitClasses = CLASSES_OF_PLACEMENT[unit.placement];
    const satisfiable = unitClasses.some((c) => allowed.has(c));
    if (!satisfiable) {
      const chain = chainOf(input.policy.placement).join(' → ');
      const reason =
        input.policy.privacy.localOnly && unitClasses.includes('cloud') && !unitClasses.includes('device')
          ? `unit "${unit.unit}" requires ${unit.placement} (${unitClasses.join('|')}) but the policy is localOnly (device only; chain ${chain})`
          : `unit "${unit.unit}" requires ${unit.placement} (${unitClasses.join('|')}) but the deployment placement ${chain} allows ${[...allowed].join('|')} only`;
      return {
        ok: false,
        code: 'DEPLOYMENT_PLAN_INCOMPATIBLE',
        detail: reason,
      };
    }
  }
  return { ok: true };
}

// ============================================================================
// The V2-004 requirement-set projection (the matcher contract)
// ============================================================================

/**
 * Project the deployment placement policy into the V2-004 requirement set
 * consumed by the merged matcher at delivery time. Capability-free by
 * design: the run-level placement decision is locality/trust/privacy; the
 * per-step capability routing belongs to the executor path.
 */
export function deploymentRequirementSetOf(policy: DeploymentPlacementPolicy): NodeRequirementSet {
  // Validate the chain (fail-closed on non-canonical ids).
  chainOf(policy.placement);
  const set: NodeRequirementSet = {
    capabilities: [],
    placement: policy.placement,
    privacy: policy.privacy,
    ...(policy.minTrustTier !== undefined ? { minTrustTier: policy.minTrustTier } : {}),
  };
  return set;
}

/** Validate a privacy constraint shape (fail-closed, typed). */
export function assertPrivacyConstraint(privacy: unknown): asserts privacy is PrivacyConstraint {
  if (typeof privacy !== 'object' || privacy === null || typeof (privacy as PrivacyConstraint).localOnly !== 'boolean') {
    throw new WorkflowDeploymentError(
      'DEPLOYMENT_INVALID_PLACEMENT',
      'privacy must be { localOnly: boolean } (V2-004\'s contract)',
    );
  }
}

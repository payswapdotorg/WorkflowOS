/**
 * V2-007 — the frozen registry vocabulary snapshot + placement semantics.
 *
 * The compiler CONSUMES the merged V2-003 implementation's frozen registry
 * vocabulary (`WORKFLOW_IR_REGISTRY_VOCABULARY` / `PLACEMENT_IDS` — the
 * implementation dependency this Work Order declares). It embeds NO
 * vocabulary of its own: canonical names come from the registry snapshot,
 * aliases are rejected, never mapped (V2-CTRL-003).
 *
 * The placement/location-class semantics table implements constitution §12
 * ("locality is a correctness constraint"): each canonical placement
 * identifier resolves to the location classes that can satisfy it. The table
 * mirrors the canonical placement semantics used by the merged V2-004 node
 * protocol (device placements admit device-class nodes; cloud placements
 * cloud-class nodes; `cloud_allowed`/`any_supported_node` admit both) — the
 * compiler re-states it as compile-time DATA because it consumes no sibling
 * implementation code, only the frozen registry vocabulary.
 */
import { PLACEMENT_IDS, WORKFLOW_IR_REGISTRY_VOCABULARY } from '../../workflow-ir/index.js';
import type { PlacementId } from '../../workflow-ir/index.js';

/** All canonical registry capability names (from the merged V2-003 snapshot). */
export const CANONICAL_CAPABILITIES: ReadonlySet<string> = new Set<string>(
  WORKFLOW_IR_REGISTRY_VOCABULARY.capabilities,
);

/** All canonical registry execution classes. */
export const CANONICAL_EXECUTION_CLASSES: ReadonlySet<string> = new Set<string>(
  WORKFLOW_IR_REGISTRY_VOCABULARY.executionClasses,
);

/** All canonical registry placement identifiers. */
export const CANONICAL_PLACEMENTS: ReadonlySet<string> = new Set<string>(PLACEMENT_IDS);

/** Is `capability` a canonical registry capability name (exact match)? */
export function isCanonicalCapability(capability: string): boolean {
  return CANONICAL_CAPABILITIES.has(capability);
}

/** Is `executionClass` a canonical registry execution class? */
export function isCanonicalExecutionClass(executionClass: string): boolean {
  return CANONICAL_EXECUTION_CLASSES.has(executionClass);
}

/** Is `placement` a canonical registry placement identifier? */
export function isCanonicalPlacement(placement: string): placement is PlacementId {
  return CANONICAL_PLACEMENTS.has(placement);
}

// ============================================================================
// Placement location-class semantics (constitution §12)
// ============================================================================

/** The coarse placement-relevant location classes. */
export type LocationClass = 'device' | 'cloud';

/**
 * The location classes that can satisfy each canonical placement
 * (the compile-time placement-compatibility table):
 *
 *   device_local        → device       (hard locality)
 *   device_preferred    → device       (preferred locality)
 *   cloud_allowed       → device, cloud
 *   cloud_preferred     → cloud        (preferred locality)
 *   cloud_required      → cloud        (hard locality)
 *   any_supported_node  → device, cloud
 */
const PLACEMENT_LOCATION_CLASSES: Readonly<Record<PlacementId, readonly LocationClass[]>> = {
  device_local: ['device'],
  device_preferred: ['device'],
  cloud_allowed: ['device', 'cloud'],
  cloud_preferred: ['cloud'],
  cloud_required: ['cloud'],
  any_supported_node: ['device', 'cloud'],
};

/** The location classes that satisfy `placement`. */
export function locationClassesOf(placement: PlacementId): readonly LocationClass[] {
  return PLACEMENT_LOCATION_CLASSES[placement];
}

/**
 * Can ONE location class satisfy BOTH placements? Placement compatibility is
 * the compile-time correctness check: a workflow whose default placement and
 * a node placement admit no common location class cannot be placed anywhere —
 * a contradiction that must be REJECTED before execution, never silently
 * downgraded (constitution §12: locality is a correctness constraint).
 */
export function placementsCompatible(a: PlacementId, b: PlacementId): boolean {
  const aClasses = PLACEMENT_LOCATION_CLASSES[a];
  const bClasses = PLACEMENT_LOCATION_CLASSES[b];
  return aClasses.some((locationClass) => bClasses.includes(locationClass));
}

import {
  CAPABILITY_AVAILABILITIES,
  HARD_LOCALITY_PLACEMENT_IDS,
  NodeCapabilityError,
  PLACEMENT_IDS,
  type CapabilityAdvertisement,
  type CapabilityRequirement,
  type NodeHealthStatus,
  type NodePlatformClass,
  type NodeTrustTier,
  type PlacementConstraint,
  type PlacementId,
} from '../types.js';

/**
 * V2-004 — the canonical protocol-registry mirror.
 *
 * Frozen read-only copy of the capability namespace and placement ids from
 * V2-CTRL-003-protocol-registry.json (schemaVersion 1.1, base SHA
 * dff907d16728c7124fab5176b21622d927178b3d). The backend deliberately does
 * NOT import the spec file at runtime; instead
 * tests/unit/node-capability/canonical-registry.test.ts proves this copy is
 * in EXACT sync with the frozen registry artifact (read-only).
 *
 * `aliasesForbidden` is honored structurally: a name outside this list is
 * rejected (fail-closed), never mapped onto a canonical name. `phone.answer_call`,
 * `calls.answer` and `messages.send` are the registry's own examples of
 * forbidden aliases.
 */

/** Canonical capability names, sorted (V2-CTRL-003 canonical namespace). */
export const CANONICAL_CAPABILITY_NAMES: readonly string[] = [
  // browser / web
  'browser.click',
  'browser.download',
  'browser.navigate',
  'browser.observe',
  'browser.select',
  'browser.type',
  'browser.upload',
  // desktop / filesystem / applications
  'application.interact',
  'application.observe',
  'application.open',
  'filesystem.read',
  'filesystem.write',
  'screen.observe',
  'ui.click',
  'ui.inspect',
  'ui.type',
  // phone / calling
  'phone.call.answer',
  'phone.call.end',
  'phone.call.identify',
  'phone.call.observe',
  'phone.call.reject',
  // messaging / contacts
  'contacts.create',
  'contacts.read',
  'contacts.search',
  'messaging.observe',
  'messaging.read',
  'messaging.send',
  // device sensors / media
  'camera.capture',
  'location.read',
  'microphone.capture',
  'notifications.observe',
  'speech.synthesis',
  // spreadsheets / business applications
  'spreadsheet.edit',
  'spreadsheet.read',
  // social systems
  'social.engagement.observe',
  'social.post.observe',
  'social.post.publish',
  // WorkflowOS-native
  'workflow.cancel',
  'workflow.deploy',
  'workflow.execute',
  'workflow.observe',
  'workflow.pause',
  'workflow.resume',
  // integration / development examples
  'github.pull_request.create',
  'github.pull_request.merge',
  'github.repository.read',
];

/** Canonical placement ids (V2-CTRL-003 canonical placement identifiers). */
export const CANONICAL_PLACEMENT_IDS: readonly PlacementId[] = [...PLACEMENT_IDS];

const CANONICAL_CAPABILITY_NAME_SET: ReadonlySet<string> = new Set(CANONICAL_CAPABILITY_NAMES);

/**
 * Error-message hints for the aliases the registry itself documents as
 * forbidden (`phone.answer_call`, `calls.answer`, `messages.send` and close
 * variants). Hints ONLY: the names are rejected, never mapped — they exist
 * so a rejected host gets an honest pointer to the canonical name.
 */
const ALIAS_HINTS: Readonly<Record<string, string>> = {
  'phone.answer_call': 'phone.call.answer',
  'phone.answer': 'phone.call.answer',
  'calls.answer': 'phone.call.answer',
  'messages.send': 'messaging.send',
  'message.send': 'messaging.send',
  'sms.send': 'messaging.send',
};

/** Registry-conformance check: is `name` a canonical capability name? */
export function isCanonicalCapabilityName(name: string): boolean {
  return CANONICAL_CAPABILITY_NAME_SET.has(name);
}

const CANONICAL_PLACEMENT_ID_SET: ReadonlySet<string> = new Set(CANONICAL_PLACEMENT_IDS);

/** Registry-conformance check: is `id` a canonical placement id? */
export function isCanonicalPlacementId(id: string): boolean {
  return CANONICAL_PLACEMENT_ID_SET.has(id);
}

/**
 * Validates one capability advertisement list (registration or update):
 * canonical names only (aliases rejected), no duplicates, integer versions
 * ≥ 1, valid availability values.
 */
export function validateCapabilityAdvertisements(
  advertisements: readonly CapabilityAdvertisement[],
): void {
  const seen = new Set<string>();
  for (const advertisement of advertisements) {
    if (!isCanonicalCapabilityName(advertisement.name)) {
      const hint = ALIAS_HINTS[advertisement.name];
      const hintSuffix = hint !== undefined ? ` (the canonical name is ${hint})` : '';
      throw new NodeCapabilityError(
        'CAPABILITY_NAME_NOT_CANONICAL',
        `capability "${advertisement.name}" is not a canonical registry capability name (V2-CTRL-003); aliases such as phone.answer_call, calls.answer or messages.send must not be introduced as alternate protocol meanings${hintSuffix}`,
      );
    }
    if (seen.has(advertisement.name)) {
      throw new NodeCapabilityError(
        'CAPABILITY_DUPLICATE_IN_ADVERTISEMENT',
        `capability "${advertisement.name}" is advertised more than once`,
      );
    }
    seen.add(advertisement.name);
    if (!Number.isInteger(advertisement.version) || advertisement.version < 1) {
      throw new NodeCapabilityError(
        'CAPABILITY_VERSION_INVALID',
        `capability "${advertisement.name}" has invalid version ${String(advertisement.version)} (must be an integer ≥ 1)`,
      );
    }
    if (!CAPABILITY_AVAILABILITIES.includes(advertisement.availability)) {
      throw new NodeCapabilityError(
        'CAPABILITY_AVAILABILITY_INVALID',
        `capability "${advertisement.name}" has invalid availability "${String(advertisement.availability)}" (expected one of ${CAPABILITY_AVAILABILITIES.join(', ')})`,
      );
    }
  }
}

/** Validates a list of capability requirements (canonical names, min ≥ 1). */
export function validateCapabilityRequirements(requirements: readonly CapabilityRequirement[]): void {
  for (const requirement of requirements) {
    if (!isCanonicalCapabilityName(requirement.name)) {
      throw new NodeCapabilityError(
        'REQUIREMENT_INVALID',
        `required capability "${requirement.name}" is not a canonical registry capability name (V2-CTRL-003); non-canonical aliases are rejected`,
      );
    }
    if (
      requirement.minVersion !== undefined &&
      (!Number.isInteger(requirement.minVersion) || requirement.minVersion < 1)
    ) {
      throw new NodeCapabilityError(
        'REQUIREMENT_INVALID',
        `required capability "${requirement.name}" has invalid minVersion ${String(requirement.minVersion)} (must be an integer ≥ 1)`,
      );
    }
  }
}

/**
 * Validates a placement constraint: canonical ids, deterministic chain — no
 * duplicate entries, no self-reference, and NO fallback chain under a hard
 * locality/correctness constraint (falling back from device_local or
 * cloud_required would silently violate locality, constitution §12/§19).
 */
export function validatePlacementConstraint(constraint: PlacementConstraint): void {
  if (!isCanonicalPlacementId(constraint.required)) {
    throw new NodeCapabilityError(
      'REQUIREMENT_INVALID',
      `placement "${String(constraint.required)}" is not a canonical placement id (V2-CTRL-003: ${CANONICAL_PLACEMENT_IDS.join(', ')})`,
    );
  }
  const fallbackOrder = constraint.fallbackOrder ?? [];
  if (fallbackOrder.length > 0 && HARD_LOCALITY_PLACEMENT_IDS.includes(constraint.required)) {
    throw new NodeCapabilityError(
      'REQUIREMENT_INVALID',
      `placement "${constraint.required}" is a hard locality/correctness constraint — a fallback chain would silently violate locality (constitution §12); declare the weaker constraint explicitly instead`,
    );
  }
  const seen = new Set<string>([constraint.required]);
  for (const entry of fallbackOrder) {
    if (!isCanonicalPlacementId(entry)) {
      throw new NodeCapabilityError(
        'REQUIREMENT_INVALID',
        `fallback placement "${String(entry)}" is not a canonical placement id (V2-CTRL-003)`,
      );
    }
    if (seen.has(entry)) {
      throw new NodeCapabilityError(
        'REQUIREMENT_INVALID',
        `fallback placement chain contains a duplicate or self-referential entry "${entry}" (the chain must be deterministic and repetition-free)`,
      );
    }
    seen.add(entry);
  }
}

/** Platform-class validation (the constitution's five host classes). */
export function isNodePlatformClass(value: string): value is NodePlatformClass {
  return (['web', 'desktop', 'ios', 'android', 'cloud'] as const).includes(value as NodePlatformClass);
}

/** Health-status validation. */
export function isNodeHealthStatus(value: string): value is NodeHealthStatus {
  return (['unhealthy', 'degraded', 'healthy'] as const).includes(value as NodeHealthStatus);
}

/** Trust-tier validation. */
export function isNodeTrustTier(value: string): value is NodeTrustTier {
  return (['untrusted', 'provisional', 'trusted'] as const).includes(value as NodeTrustTier);
}

/**
 * The placement chain satisfaction table (deterministic): the node location
 * classes that satisfy each canonical placement id. `device_preferred` and
 * `cloud_preferred` are intentionally strict — the non-preferred class is
 * admitted ONLY through an explicit fallbackOrder entry, never silently
 * (constitution §19: no silent substitution).
 */
const PLACEMENT_SATISFIED_LOCATION_CLASSES: Readonly<
  Record<PlacementId, readonly ('device' | 'cloud')[]>
> = {
  device_local: ['device'],
  device_preferred: ['device'],
  cloud_allowed: ['device', 'cloud'],
  cloud_preferred: ['cloud'],
  cloud_required: ['cloud'],
  any_supported_node: ['device', 'cloud'],
};

/** Does `locationClass` satisfy `placement`? */
export function placementSatisfiedByLocationClass(
  placement: PlacementId,
  locationClass: 'device' | 'cloud',
): boolean {
  return PLACEMENT_SATISFIED_LOCATION_CLASSES[placement].includes(locationClass);
}

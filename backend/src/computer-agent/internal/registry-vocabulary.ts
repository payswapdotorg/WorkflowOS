/**
 * V2-008 — the frozen protocol-registry vocabulary snapshot.
 *
 * Source of truth: `spec/architecture/v2/V2-CTRL-003-protocol-registry.json`
 * frozen at the V2-008 activation base SHA `d36499cb95c6fe80a58346cfb7452b2bf75d7a28`
 * (post-W3-gates main). The registry is FROZEN for V2-008 (never edited in
 * this Work Order). The embedded copy exists so the runtime module has zero
 * spec-tree coupling; the registry-conformance battery proves the copy equals
 * the registry file on disk (no drift), and any governed registry extension
 * requires a real architecture change — never a silent widening here.
 *
 * Deliberately NOT embedded: the registry's attestation object types — they
 * are V2-014's frozen identifiers, referenced ONLY through the merged
 * execution-attestation barrel (pinned at source level by the
 * module-boundary test).
 */

/** Provenance of this snapshot (recorded, verifiable). */
export const REGISTRY_SOURCE_FILE = 'spec/architecture/v2/V2-CTRL-003-protocol-registry.json';
export const REGISTRY_FROZEN_AT_SHA = 'd36499cb95c6fe80a58346cfb7452b2bf75d7a28';

/** All canonical capability names (flattened across registry namespaces). */
export const CANONICAL_CAPABILITIES: readonly string[] = [
  // browser / web
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.observe',
  'browser.download',
  'browser.upload',
  // desktop / filesystem / applications
  'filesystem.read',
  'filesystem.write',
  'application.open',
  'application.observe',
  'application.interact',
  'screen.observe',
  'ui.inspect',
  'ui.click',
  'ui.type',
  // phone / calling
  'phone.call.observe',
  'phone.call.identify',
  'phone.call.answer',
  'phone.call.reject',
  'phone.call.end',
  // messaging / contacts
  'messaging.observe',
  'messaging.read',
  'messaging.send',
  'contacts.read',
  'contacts.search',
  'contacts.create',
  // device sensors / media
  'notifications.observe',
  'microphone.capture',
  'speech.synthesis',
  'camera.capture',
  'location.read',
  // spreadsheets / business applications
  'spreadsheet.read',
  'spreadsheet.edit',
  // social systems
  'social.post.observe',
  'social.post.publish',
  'social.engagement.observe',
  // WorkflowOS-native
  'workflow.execute',
  'workflow.pause',
  'workflow.resume',
  'workflow.cancel',
  'workflow.deploy',
  'workflow.observe',
  // integration / development examples
  'github.repository.read',
  'github.pull_request.create',
  'github.pull_request.merge',
];

/** Canonical execution classes (registry: executionClasses). */
export const CANONICAL_EXECUTION_CLASSES: readonly string[] = [
  'deterministic_api',
  'agentic_computer_use',
  'human',
  'subworkflow',
];

/** Canonical placement identifiers (registry: placement). */
export const CANONICAL_PLACEMENT_IDS: readonly string[] = [
  'device_local',
  'device_preferred',
  'cloud_allowed',
  'cloud_preferred',
  'cloud_required',
  'any_supported_node',
];

/** Canonical assurance levels (registry: assurance). */
export const CANONICAL_ASSURANCE_LEVELS: readonly string[] = [
  'software_signed',
  'hardware_backed',
  'tee_attested',
  'verifiable_computation',
];

/** The registry authority rules (verbatim; the non-authority discipline). */
export const CANONICAL_AUTHORITY_RULES: readonly string[] = [
  'capability-advertisement-is-not-authorization',
  'marketplace-entitlement-is-not-execution-authority',
  'command-ack-is-not-side-effect-evidence',
  'signature-is-not-automatic-execution-truth',
  'attestation-is-not-verification-authority',
];

const CAPABILITY_SET = new Set<string>(CANONICAL_CAPABILITIES);

/** Is `capability` a canonical registry capability name (exact match)? */
export function isCanonicalCapability(capability: string): boolean {
  return CAPABILITY_SET.has(capability);
}

/**
 * The public frozen vocabulary snapshot (mirrors the registry file's
 * computer-agent-relevant sections — pinned by the registry-conformance
 * battery against the registry file; deliberately WITHOUT the attestation
 * object types).
 */
export const COMPUTER_AGENT_REGISTRY_VOCABULARY = {
  registrySource: REGISTRY_SOURCE_FILE,
  registryFrozenAt: REGISTRY_FROZEN_AT_SHA,
  capabilities: CANONICAL_CAPABILITIES,
  executionClasses: CANONICAL_EXECUTION_CLASSES,
  placement: CANONICAL_PLACEMENT_IDS,
  assurance: CANONICAL_ASSURANCE_LEVELS,
  authorityRules: CANONICAL_AUTHORITY_RULES,
} as const;

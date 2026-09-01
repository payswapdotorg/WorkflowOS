/**
 * V2-014 — the frozen protocol-registry vocabulary snapshot.
 *
 * Source of truth: `spec/architecture/v2/V2-CTRL-003-protocol-registry.json`
 * frozen at the W2A activation base SHA `9d2504592badded04cb531c73791bf3e7313ce92`.
 *
 * The registry is FROZEN for V2-014 (never edited in this Work Order). The
 * embedded copy exists so the runtime module has zero spec-tree coupling; the
 * module-boundary test proves the copy equals the registry file on disk (no
 * drift), and any governed registry extension requires updating this
 * snapshot through a real architecture change — never silently.
 *
 * Deliberately NOT included here: the registry's THIRD attestation object
 * type `workflowos/execution-proof-graph/v1`. It belongs to V2-015 (proof
 * graphs / trust-minimized coordination) and is out of V2-014's ownership;
 * this module must contain no proof-graph concepts (pinned at source level by
 * the module-boundary test).
 */
import type { AssuranceLevel, CapabilityName, ExecutionAttestationEventName, ExecutionClass } from '../types.js';

/** Provenance of this snapshot (recorded, verifiable). */
export const REGISTRY_SOURCE_FILE = 'spec/architecture/v2/V2-CTRL-003-protocol-registry.json';
export const REGISTRY_FROZEN_AT_SHA = '9d2504592badded04cb531c73791bf3e7313ce92';

/** All canonical capability names (flattened across registry namespaces). */
export const CANONICAL_CAPABILITIES: readonly CapabilityName[] = [
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
export const CANONICAL_EXECUTION_CLASSES: readonly ExecutionClass[] = [
  'deterministic_api',
  'agentic_computer_use',
  'human',
  'subworkflow',
];

/** Canonical execution assurance identifiers (registry: assurance). */
export const CANONICAL_ASSURANCE_LEVELS: readonly AssuranceLevel[] = [
  'software_signed',
  'hardware_backed',
  'tee_attested',
  'verifiable_computation',
];

/**
 * The V2-014 attestation object types (registry: attestationObjectTypes,
 * EXCLUDING the proof-graph type owned by V2-015 — see the file header).
 */
export const CANONICAL_ATTESTATION_OBJECT_TYPES = [
  'workflowos/execution-statement/v1',
  'workflowos/execution-attestation/v1',
] as const;

/** Canonical attestation lifecycle events (registry: events, filtered). */
export const CANONICAL_ATTESTATION_EVENTS: readonly ExecutionAttestationEventName[] = [
  'execution.attestation.issued',
  'execution.attestation.verified',
];

/** The registry digest rule's execution domain (registry: digest.executionDomain). */
export const DIGEST_EXECUTION_DOMAIN = 'workflowos/execution-statement/v1';

/** The registry authority rules (verbatim; the non-authority discipline). */
export const CANONICAL_AUTHORITY_RULES: readonly string[] = [
  'capability-advertisement-is-not-authorization',
  'marketplace-entitlement-is-not-execution-authority',
  'command-ack-is-not-side-effect-evidence',
  'signature-is-not-automatic-execution-truth',
  'attestation-is-not-verification-authority',
];

const CAPABILITY_SET = new Set<string>(CANONICAL_CAPABILITIES);
const EXECUTION_CLASS_SET = new Set<string>(CANONICAL_EXECUTION_CLASSES);
const ASSURANCE_SET = new Set<string>(CANONICAL_ASSURANCE_LEVELS);

/** Is `capability` a canonical registry capability name (exact match)? */
export function isCanonicalCapability(capability: string): boolean {
  return CAPABILITY_SET.has(capability);
}

/** Is `executionClass` a canonical registry execution class? */
export function isCanonicalExecutionClass(executionClass: string): executionClass is ExecutionClass {
  return EXECUTION_CLASS_SET.has(executionClass);
}

/** Is `assurance` a canonical assurance identifier? */
export function isCanonicalAssurance(assurance: string): assurance is AssuranceLevel {
  return ASSURANCE_SET.has(assurance);
}

/**
 * The public frozen vocabulary snapshot (mirrors the registry file's
 * attestation-relevant sections — pinned by the module-boundary test against
 * the registry file).
 */
export const EXECUTION_ATTESTATION_REGISTRY_VOCABULARY = {
  registrySource: REGISTRY_SOURCE_FILE,
  registryFrozenAt: REGISTRY_FROZEN_AT_SHA,
  capabilities: CANONICAL_CAPABILITIES,
  executionClasses: CANONICAL_EXECUTION_CLASSES,
  assurance: CANONICAL_ASSURANCE_LEVELS,
  attestationObjectTypes: CANONICAL_ATTESTATION_OBJECT_TYPES,
  events: CANONICAL_ATTESTATION_EVENTS,
  digestExecutionDomain: DIGEST_EXECUTION_DOMAIN,
  authorityRules: CANONICAL_AUTHORITY_RULES,
} as const;

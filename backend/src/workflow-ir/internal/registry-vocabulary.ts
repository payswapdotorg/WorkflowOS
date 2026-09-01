/**
 * V2-003 — the frozen protocol-registry vocabulary snapshot.
 *
 * Source of truth: `spec/architecture/v2/V2-CTRL-003-protocol-registry.json`
 * frozen at the W1 activation base SHA `dff907d16728c7124fab5176b21622d927178b3d`.
 *
 * The registry is FROZEN for V2-003 (never edited in this Work Order). The
 * embedded copy exists so the runtime module has zero filesystem/spec-tree
 * coupling; the test battery proves the copy equals the registry file on
 * disk (no drift), and any governed registry extension requires updating
 * this snapshot through a real architecture change — never silently.
 *
 * Deliberately NOT included here: the registry's attestation object types
 * and assurance identifiers. Those are V2-014's domain, and this module
 * must contain no execution-attestation concepts (domain separation is
 * proven by tests, not by vocabulary proximity).
 */
import type { CapabilityName, CompletionEvidenceClass, ExecutionClass, PlacementId } from '../types.js';

/** Provenance of this snapshot (recorded, verifiable). */
export const REGISTRY_SOURCE_FILE = 'spec/architecture/v2/V2-CTRL-003-protocol-registry.json';
export const REGISTRY_FROZEN_AT_SHA = 'dff907d16728c7124fab5176b21622d927178b3d';

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

/** Canonical placement identifiers (registry: placement). */
export const CANONICAL_PLACEMENT_IDS: readonly PlacementId[] = [
  'device_local',
  'device_preferred',
  'cloud_allowed',
  'cloud_preferred',
  'cloud_required',
  'any_supported_node',
];

/**
 * All five canonical evidence classes (registry: evidence) — recorded for
 * vocabulary completeness; only the three completion-establishing classes
 * are valid as IR completion evidence (see COMPLETION_EVIDENCE_CLASSES).
 */
export const CANONICAL_EVIDENCE_CLASSES: readonly string[] = [
  'intent',
  'observation',
  'claim',
  'verification',
  'human_confirmation',
];

/** The evidence classes that may establish step completion (constitution §7). */
export const COMPLETION_ESTABLISHING_EVIDENCE_CLASSES: readonly CompletionEvidenceClass[] = [
  'observation',
  'verification',
  'human_confirmation',
];

const CAPABILITY_SET = new Set<string>(CANONICAL_CAPABILITIES);
const EXECUTION_CLASS_SET = new Set<string>(CANONICAL_EXECUTION_CLASSES);
const PLACEMENT_SET = new Set<string>(CANONICAL_PLACEMENT_IDS);
const COMPLETION_EVIDENCE_SET = new Set<string>(COMPLETION_ESTABLISHING_EVIDENCE_CLASSES);

/** Is `capability` a canonical registry capability name (exact match)? */
export function isCanonicalCapability(capability: string): boolean {
  return CAPABILITY_SET.has(capability);
}

/** Is `executionClass` a canonical registry execution class? */
export function isCanonicalExecutionClass(executionClass: string): executionClass is ExecutionClass {
  return EXECUTION_CLASS_SET.has(executionClass);
}

/** Is `placement` a canonical registry placement identifier? */
export function isCanonicalPlacement(placement: string): placement is PlacementId {
  return PLACEMENT_SET.has(placement);
}

/** Is `evidenceClass` a completion-establishing evidence class? */
export function isCompletionEvidenceClass(evidenceClass: string): evidenceClass is CompletionEvidenceClass {
  return COMPLETION_EVIDENCE_SET.has(evidenceClass);
}

/**
 * The public frozen vocabulary snapshot (mirrors the registry file's
 * relevant sections — used by tests to pin no-drift against the registry).
 */
export const WORKFLOW_IR_REGISTRY_VOCABULARY = {
  registrySource: REGISTRY_SOURCE_FILE,
  registryFrozenAt: REGISTRY_FROZEN_AT_SHA,
  capabilities: CANONICAL_CAPABILITIES,
  executionClasses: CANONICAL_EXECUTION_CLASSES,
  placement: CANONICAL_PLACEMENT_IDS,
  evidence: CANONICAL_EVIDENCE_CLASSES,
} as const;

/**
 * V2-005 — the frozen protocol-registry vocabulary snapshot.
 *
 * Source of truth: `spec/architecture/v2/V2-CTRL-003-protocol-registry.json`
 * frozen at the W2B activation base SHA `bdce0eacbb4fac3ece4ebf95861731de3eed474d`
 * (post-W2A main). The registry is FROZEN for V2-005 (never edited in this
 * Work Order). The embedded copy exists so the runtime module has zero
 * spec-tree coupling; the registry-conformance battery proves the copy equals
 * the registry file on disk (no drift), and any governed registry extension
 * requires updating this snapshot through a real architecture change — never
 * silently.
 *
 * Deliberately NOT embedded: the registry's attestation object types — they
 * are V2-014's frozen identifiers and this module references them ONLY
 * through the merged execution-attestation barrel (never as literals — pinned
 * at source level by the module-boundary test).
 */
import type { RunEvidenceClass, RunExecutionClass, RunTimelineEventName } from '../types.js';

/** Provenance of this snapshot (recorded, verifiable). */
export const REGISTRY_SOURCE_FILE = 'spec/architecture/v2/V2-CTRL-003-protocol-registry.json';
export const REGISTRY_FROZEN_AT_SHA = 'bdce0eacbb4fac3ece4ebf95861731de3eed474d';

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
export const CANONICAL_EXECUTION_CLASSES: readonly RunExecutionClass[] = [
  'deterministic_api',
  'agentic_computer_use',
  'human',
  'subworkflow',
];

/** Canonical evidence classes (registry: evidence). */
export const CANONICAL_EVIDENCE_CLASSES: readonly RunEvidenceClass[] = [
  'intent',
  'observation',
  'claim',
  'verification',
  'human_confirmation',
];

/**
 * The registry event names this module projects into the run timeline
 * (VERBATIM registry names — a strict subset of the registry's event list).
 */
export const CANONICAL_RUN_EVENTS: readonly RunTimelineEventName[] = [
  'workflow.run.requested',
  'workflow.run.started',
  'workflow.run.paused',
  'workflow.run.resumed',
  'workflow.run.completed',
  'workflow.run.failed',
  'workflow.step.started',
  'workflow.step.completed',
  'capability.invocation.requested',
  'capability.invocation.completed',
  'observation.recorded',
  'verification.completed',
  'execution.attestation.verified',
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
const EXECUTION_CLASS_SET = new Set<string>(CANONICAL_EXECUTION_CLASSES);
const EVIDENCE_CLASS_SET = new Set<string>(CANONICAL_EVIDENCE_CLASSES);

/** Is `capability` a canonical registry capability name (exact match)? */
export function isCanonicalCapability(capability: string): boolean {
  return CAPABILITY_SET.has(capability);
}

/** Is `executionClass` a canonical registry execution class? */
export function isCanonicalExecutionClass(executionClass: string): executionClass is RunExecutionClass {
  return EXECUTION_CLASS_SET.has(executionClass);
}

/** Is `evidenceClass` a canonical registry evidence class? */
export function isCanonicalEvidenceClass(evidenceClass: string): evidenceClass is RunEvidenceClass {
  return EVIDENCE_CLASS_SET.has(evidenceClass);
}

/**
 * The public frozen vocabulary snapshot (mirrors the registry file's
 * run-relevant sections — pinned by the registry-conformance battery against
 * the registry file; deliberately WITHOUT the attestation object types).
 */
export const RUN_REGISTRY_VOCABULARY = {
  registrySource: REGISTRY_SOURCE_FILE,
  registryFrozenAt: REGISTRY_FROZEN_AT_SHA,
  capabilities: CANONICAL_CAPABILITIES,
  executionClasses: CANONICAL_EXECUTION_CLASSES,
  evidence: CANONICAL_EVIDENCE_CLASSES,
  events: CANONICAL_RUN_EVENTS,
  authorityRules: CANONICAL_AUTHORITY_RULES,
} as const;

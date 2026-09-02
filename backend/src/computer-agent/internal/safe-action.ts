/**
 * V2-008 — the safe-action boundary (the runtime-side authorization
 * dimension for sensitive capabilities).
 *
 * Constitution §5 (authorization is a SEPARATE dimension — capability
 * advertisement, node trust and run policy never imply it) and §16 (each
 * sensitive capability has its own authorization/consent boundary; device
 * access is not blanket access to device data).
 *
 * This module classifies canonical registry capabilities into the runtime's
 * own policy vocabulary (`sensitive` | `ordinary`) — the registry has NO
 * sensitivity dimension, so this classification is honestly module-scoped
 * policy, not a registry authority. Every classified name is a canonical
 * registry capability name verbatim (fail-closed on unknown names).
 */
import type { SafeActionGrant, SafeActionPolicy, CapabilitySensitivity } from '../types.js';
import { isCanonicalCapability } from './registry-vocabulary.js';

/**
 * The sensitive set: capabilities that read private device data beyond the
 * active browser page, sense the environment, or cause external side
 * effects. Every invocation of one of these by the AGENT requires an
 * explicit per-capability grant (scope run or the exact step).
 *
 * HUMAN takeover actions are consented by the acting human (the human IS
 * the authorizing actor on their own host) — recorded distinctly, never
 * silently re-classified.
 */
const SENSITIVE_CAPABILITY_NAMES: readonly string[] = [
  // private data reads (beyond the active browser surface)
  'filesystem.read',
  'messaging.read',
  'contacts.read',
  'contacts.search',
  'notifications.observe',
  'location.read',
  // external / persisted side effects
  'filesystem.write',
  'spreadsheet.edit',
  'messaging.send',
  'contacts.create',
  'social.post.publish',
  'github.pull_request.create',
  'github.pull_request.merge',
  'browser.download',
  'browser.upload',
  // live-call side effects
  'phone.call.answer',
  'phone.call.reject',
  'phone.call.end',
  // environment sensing / actuation
  'camera.capture',
  'microphone.capture',
  'speech.synthesis',
];

const SENSITIVE_SET = new Set<string>(SENSITIVE_CAPABILITY_NAMES);

/**
 * The sensitivity classification of one canonical capability (fail-closed:
 * a non-canonical name is NEVER classified — it is rejected upstream).
 */
export function capabilitySensitivityOf(capability: string): CapabilitySensitivity {
  return SENSITIVE_SET.has(capability) ? 'sensitive' : 'ordinary';
}

/** The frozen sensitive set (verbatim canonical registry names). */
export function sensitiveCapabilities(): readonly string[] {
  return SENSITIVE_CAPABILITY_NAMES;
}

/**
 * Does the policy explicitly grant the sensitive `capability` for `stepId`?
 *
 * A grant authorizes when its scope is `run`, or its scope is `step` and its
 * stepId matches exactly. An unknown capability name never matches (the
 * canonical check happens at the invocation boundary as well).
 */
export function isCapabilityGranted(
  policy: SafeActionPolicy,
  capability: string,
  stepId: string,
): boolean {
  return policy.grants.some(
    (grant: SafeActionGrant) =>
      grant.capability === capability && (grant.scope === 'run' || (grant.scope === 'step' && grant.stepId === stepId)),
  );
}

/**
 * The authorization gate for ONE agent invocation (fail-closed).
 *
 * Returns `ok: true` when the capability is ordinary or explicitly granted;
 * otherwise a typed authorization rejection the runtime records and honors
 * (never a silent fallback or emulation — constitution §5).
 */
export function checkInvocationAuthorization(
  policy: SafeActionPolicy,
  capability: string,
  stepId: string,
): { ok: true } | { ok: false; reason: 'capability-not-canonical' | 'sensitive-capability-ungranted' } {
  if (!isCanonicalCapability(capability)) {
    return { ok: false, reason: 'capability-not-canonical' };
  }
  if (capabilitySensitivityOf(capability) === 'sensitive' && !isCapabilityGranted(policy, capability, stepId)) {
    return { ok: false, reason: 'sensitive-capability-ungranted' };
  }
  return { ok: true };
}

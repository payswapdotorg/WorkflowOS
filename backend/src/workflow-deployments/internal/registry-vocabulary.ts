/**
 * V2-009 — the frozen protocol-registry vocabulary snapshot.
 *
 * Source of truth: `spec/architecture/v2/V2-CTRL-003-protocol-registry.json`
 * frozen at the V2-009 activation base SHA `b349233...` (post-V2-008 main).
 * The registry is FROZEN for V2-009 (never edited in this Work Order). The
 * embedded copy exists so the trigger module has zero spec-tree coupling;
 * the registry-conformance battery proves the copy equals the registry file
 * on disk (no drift), and any governed registry extension requires a real
 * architecture change — never a silent widening here.
 *
 * Deliberately embedded here (unlike the other V2 families): the registry's
 * EVENT vocabulary is this module's primary contract surface (constitution
 * §11: "Canonical event identifiers are governed by V2-CTRL-003"). The
 * trigger-type vocabulary is V2-005's frozen RUN_TRIGGER_TYPES (consumed —
 * mirrored here only for the no-drift battery).
 */

/** Provenance of this snapshot (recorded, verifiable). */
export const REGISTRY_SOURCE_FILE = 'spec/architecture/v2/V2-CTRL-003-protocol-registry.json';
export const REGISTRY_FROZEN_AT_SHA = 'b349233ba735db4a68732005cf544ef1a35c23b6';

export const TRIGGER_REGISTRY_VOCABULARY = {
  sourceFile: REGISTRY_SOURCE_FILE,
  frozenAtSha: REGISTRY_FROZEN_AT_SHA,
  /** All canonical registry event names (verbatim; the ingest vocabulary). */
  events: [
    'workflow.run.requested',
    'workflow.run.started',
    'workflow.step.started',
    'workflow.step.completed',
    'workflow.run.paused',
    'workflow.run.resumed',
    'workflow.run.completed',
    'workflow.run.failed',
    'capability.invocation.requested',
    'capability.invocation.completed',
    'observation.recorded',
    'verification.completed',
    'execution.attestation.issued',
    'execution.attestation.verified',
    'execution.proof.updated',
    'device.connected',
    'device.disconnected',
    'phone.call.received',
    'phone.call.ended',
    'messaging.message.received',
    'notification.received',
    'file.created',
    'file.changed',
    'application.opened',
    'social.post.engagement.threshold_crossed',
    'workflow.deployment.enabled',
    'workflow.deployment.disabled',
  ] as const,
  /** Canonical placement identifiers (V2-004's — verbatim). */
  placement: [
    'device_local',
    'device_preferred',
    'cloud_allowed',
    'cloud_preferred',
    'cloud_required',
    'any_supported_node',
  ] as const,
  /** V2-005's frozen run trigger types (consumed — verbatim). */
  triggerTypes: [
    'manual',
    'schedule',
    'webhook',
    'application_event',
    'file_event',
    'communication_event',
    'device_event',
    'social_threshold_event',
    'workflow_lifecycle_event',
  ] as const,
} as const;

/** The registry event-name set (fast membership). */
export const REGISTRY_EVENT_NAMES: ReadonlySet<string> = new Set<string>(TRIGGER_REGISTRY_VOCABULARY.events);

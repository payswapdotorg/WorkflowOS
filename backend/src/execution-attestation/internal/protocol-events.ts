/**
 * V2-014 — typed protocol events for the attestation lifecycle.
 *
 * Canonical registry names ONLY (V2-CTRL-003): `execution.attestation.issued`
 * and `execution.attestation.verified`. Aliases are forbidden — the event
 * name type admits exactly the two canonical names, so no alternate spelling
 * can exist as a protocol meaning.
 *
 * Events are PURE DATA: deterministic identity derived from
 * (event name, attestation id), injected occurrence clock, no side effects.
 * Representing these events does not deliver them — trigger/routing delivery
 * is a later Work Order's concern.
 */
import { createHash } from 'node:crypto';
import { ATTESTATION_EVENT_ID_PREFIX } from '../types.js';
import type {
  ExecutionAttestation,
  ExecutionAttestationEventName,
  ExecutionAttestationProtocolEvent,
  UtcTimestamp,
  VerifiedExecutionFact,
} from '../types.js';

function deriveEventId(eventType: ExecutionAttestationEventName, attestationId: string): string {
  const digest = createHash('sha256')
    .update(`${eventType}|${attestationId}`, 'utf8')
    .digest('hex');
  return `${ATTESTATION_EVENT_ID_PREFIX}${digest.slice(0, 32)}`;
}

/** The typed `execution.attestation.issued` event (registry name, verbatim). */
export function attestationIssuedEvent(
  attestation: ExecutionAttestation,
  occurredAt: UtcTimestamp,
): ExecutionAttestationProtocolEvent {
  return {
    eventType: 'execution.attestation.issued',
    eventId: deriveEventId('execution.attestation.issued', attestation.attestationId),
    occurredAt,
    attestationId: attestation.attestationId,
    executionDigest: attestation.executionDigest.digest,
    attesterKeyId: attestation.attesterKeyId,
  };
}

/** The typed `execution.attestation.verified` event (registry name, verbatim). */
export function attestationVerifiedEvent(
  fact: VerifiedExecutionFact,
  occurredAt: UtcTimestamp,
): ExecutionAttestationProtocolEvent {
  return {
    eventType: 'execution.attestation.verified',
    eventId: deriveEventId('execution.attestation.verified', fact.attestationId),
    occurredAt,
    attestationId: fact.attestationId,
    executionDigest: fact.executionDigest.digest,
    attesterKeyId: fact.attesterKeyId,
  };
}

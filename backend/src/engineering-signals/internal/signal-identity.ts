/**
 * WORK-067 — the deterministic signal identity derivation.
 *
 * PURE: no randomness, no clock, no process-local state. The logical
 * signal identity is a sha256 over the canonical scope + classification
 * fields (tenant, project, environment, logicalFailureKey) — the same
 * logical failure observed any number of times (any source, any run)
 * converges on ONE identity, while a different tenant, project,
 * environment, or a different logical failure NEVER collapses onto it.
 *
 * The occurrence identity is a sha256 over (the signal identity, the raw
 * observation reference, the observation time): re-delivery of the same
 * observation is the same occurrence (idempotent); the same logical
 * failure observed at a new time (or through a distinct source record)
 * is a NEW occurrence appended to the SAME signal.
 */
import { createHash } from 'node:crypto';
import { EngineeringSignalError } from '../types.js';
import type {
  SignalIdentity,
  SignalIdentityInput,
  SignalObservationReference,
} from '../types.js';

/** Canonical serialization (stable key order — determinism). */
function canonical(fields: Record<string, string>): string {
  const keys = Object.keys(fields).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${key}=${fields[key]}`);
  }
  return parts.join('|');
}

function requireNonEmpty(
  value: string,
  field: string,
  code: 'SIGNAL_TENANT_REQUIRED' | 'SIGNAL_PROJECT_REQUIRED' | 'SIGNAL_ENVIRONMENT_REQUIRED' | 'SIGNAL_LOGICAL_KEY_REQUIRED',
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EngineeringSignalError(code, `the signal identity requires a non-empty ${field}`);
  }
  return value;
}

/**
 * Derive the logical signal identity. Deterministic: identical inputs →
 * byte-identical identity (the dedup convergence key).
 */
export function deriveSignalIdentity(input: SignalIdentityInput): SignalIdentity {
  const tenantId = requireNonEmpty(input.tenantId, 'tenant id', 'SIGNAL_TENANT_REQUIRED');
  const projectId = requireNonEmpty(input.projectId, 'project id', 'SIGNAL_PROJECT_REQUIRED');
  const environmentId = requireNonEmpty(input.environmentId, 'environment id', 'SIGNAL_ENVIRONMENT_REQUIRED');
  const logicalFailureKey = requireNonEmpty(input.logicalFailureKey, 'logical failure key', 'SIGNAL_LOGICAL_KEY_REQUIRED');

  const identityHash = createHash('sha256')
    .update(
      canonical({
        tenantId,
        projectId,
        environmentId,
        logicalFailureKey,
      }),
    )
    .digest('hex');
  return {
    signalId: `sig_${identityHash.slice(0, 24)}`,
    identityFingerprint: `sgf_${identityHash}`,
  };
}

/**
 * Derive the per-occurrence identity. Deterministic over (signal identity
 * fingerprint, the raw observation reference, the observation time): the
 * idempotent re-delivery key.
 */
export function deriveOccurrenceIdentity(
  identity: SignalIdentity,
  observationRef: SignalObservationReference,
  observedAt: string,
): string {
  const occurrenceHash = createHash('sha256')
    .update(
      canonical({
        identityFingerprint: identity.identityFingerprint,
        refKind: observationRef.kind,
        ref: observationRef.ref,
        observedAt,
      }),
    )
    .digest('hex');
  return `occ_${occurrenceHash.slice(0, 24)}`;
}

/**
 * The deterministic occurrence ordering used by every derived signal
 * attribute (first/last observed, latest severity, before/after splits):
 * (observedAt, recordedAt, occurrenceId) — no wall-clock reads, no
 * insertion-order dependence.
 */
export function compareOccurrences(
  a: { observedAt: string; recordedAt: string; occurrenceId: string },
  b: { observedAt: string; recordedAt: string; occurrenceId: string },
): number {
  if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? -1 : 1;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
  if (a.occurrenceId !== b.occurrenceId) return a.occurrenceId < b.occurrenceId ? -1 : 1;
  return 0;
}

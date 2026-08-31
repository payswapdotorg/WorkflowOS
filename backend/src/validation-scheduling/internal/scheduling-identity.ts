/**
 * WORK-066 — the deterministic scheduling identity derivation.
 *
 * PURE: no randomness, no clock, no process-local state. The identity is a
 * sha256 over the canonical logical-event fields (trigger, project, journey,
 * environment, mode, reference). The content fingerprint additionally binds
 * the assurance classification — a re-delivery with the same identity but a
 * different classification is a typed CONFLICT (the same logical event
 * cannot warrant two different assurance levels). The run id is derived from
 * the identity deterministically, so the scheduled validation can always
 * explain why it exists:
 *
 *   trigger → project → journey → environment → revision/release/window
 *          → scheduling decision → validation run
 */
import { createHash } from 'node:crypto';
import { ValidationSchedulingError } from '../types.js';
import type { SchedulingIdentity, SchedulingIdentityInput } from '../types.js';

/** Canonical serialization (stable key order — determinism). */
function canonical(fields: Record<string, string>): string {
  const keys = Object.keys(fields).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${key}=${fields[key]}`);
  }
  return parts.join('|');
}

function requireNonEmpty(value: string | undefined, field: string, code: Parameters<typeof errorOf>[0]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw errorOf(code, `the scheduling identity requires a non-empty ${field}`);
  }
  return value;
}

function errorOf(
  code: 'SCHEDULING_PROJECT_REQUIRED' | 'SCHEDULING_REVISION_REQUIRED' | 'SCHEDULING_RELEASE_REFERENCE_REQUIRED',
  message: string,
): ValidationSchedulingError {
  return new ValidationSchedulingError(code, message);
}

/**
 * Derive the scheduling identity (the logical identity of a scheduled
 * validation). Deterministic: identical inputs → byte-identical identity.
 */
export function deriveSchedulingIdentity(input: SchedulingIdentityInput & { assurance: string }): SchedulingIdentity {
  const projectId = requireNonEmpty(input.projectId, 'project id', 'SCHEDULING_PROJECT_REQUIRED');
  const reference = requireNonEmpty(input.reference, 'logical reference (revision/release/window/signal)', 'SCHEDULING_REVISION_REQUIRED');
  if (typeof input.journeyId !== 'string' || input.journeyId.trim() === '') {
    throw new ValidationSchedulingError('SCHEDULING_JOURNEY_MISSING', 'the scheduling identity requires a non-empty journey id');
  }
  if (typeof input.environmentId !== 'string' || input.environmentId.trim() === '') {
    throw new ValidationSchedulingError('SCHEDULING_ENVIRONMENT_REQUIRED', 'the scheduling identity requires a non-empty environment id');
  }

  const identityHash = createHash('sha256')
    .update(
      canonical({
        trigger: input.trigger,
        projectId,
        journeyId: input.journeyId,
        environmentId: input.environmentId,
        mode: input.mode,
        reference,
      }),
    )
    .digest('hex');
  const fingerprintHash = createHash('sha256')
    .update(`${identityHash}|assurance=${input.assurance}`)
    .digest('hex');
  return {
    schedulingId: `svs_${identityHash.slice(0, 24)}`,
    contentFingerprint: `svf_${fingerprintHash.slice(0, 24)}`,
    runId: `svr_${identityHash.slice(0, 12)}`,
  };
}

/** The canonical reference for a CONTINUOUS scheduled window (the cadence identity). */
export function scheduledWindowReference(windowIndex: number): string {
  return `scheduled-window:${windowIndex}`;
}

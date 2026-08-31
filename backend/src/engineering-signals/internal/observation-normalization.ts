/**
 * WORK-067 — the raw observation normalization boundary (the TEMPORARY
 * compatibility seam).
 *
 * Validates every {@link RawObservationInput} field fail-closed (the
 * closed source/severity vocabularies, the required scope dimensions, the
 * recorded observation time, the raw observation reference, the raw
 * payload presence) and derives the normalized {@link SignalOccurrence}.
 *
 * THE SEAM (spec/work-orders/WORK-067.md "Relationship to WORK-056"):
 * this normalization is explicitly TEMPORARY — WORK-056 (planned) owns
 * the signal taxonomy and intake; when it lands, this seam delegates to
 * it. Until then the discipline is the same provenance preservation
 * WORK-056 will require: nothing is dropped, nothing is silently
 * defaulted, and a failure observation can NEVER be discarded or
 * converted (the no-silent-healthy invariant — carried forward from
 * WORK-064).
 */
import { SIGNAL_SOURCES, SIGNAL_SEVERITIES, EngineeringSignalError } from '../types.js';
import type {
  RawObservationInput,
  SignalOccurrence,
  SignalObservationReference,
  SignalSeverity,
  SignalSource,
  SignalIdentity,
} from '../types.js';
import { deriveOccurrenceIdentity } from './signal-identity.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Require a source from the CLOSED vocabulary (foreign values fail closed). */
export function requireValidSource(source: string): SignalSource {
  if (typeof source !== 'string' || !SIGNAL_SOURCES.includes(source as SignalSource)) {
    throw new EngineeringSignalError(
      'SIGNAL_SOURCE_UNKNOWN',
      `the observation source '${String(source)}' is not in the closed SIGNAL_SOURCES vocabulary`,
    );
  }
  return source as SignalSource;
}

/** Require a severity from the CLOSED vocabulary (foreign values fail closed). */
export function requireValidSeverity(severity: string): SignalSeverity {
  if (typeof severity !== 'string' || !SIGNAL_SEVERITIES.includes(severity as SignalSeverity)) {
    throw new EngineeringSignalError(
      'SIGNAL_SEVERITY_UNKNOWN',
      `the observation severity '${String(severity)}' is not in the closed SIGNAL_SEVERITIES vocabulary (the repository's existing critical/high/medium/low)`,
    );
  }
  return severity as SignalSeverity;
}

/** Require a RECORDED ISO-8601 observation time (never the processing clock). */
export function requireValidObservedAt(observedAt: string): string {
  if (typeof observedAt !== 'string' || !ISO_TIMESTAMP.test(observedAt)) {
    throw new EngineeringSignalError(
      'SIGNAL_OBSERVED_AT_INVALID',
      `the observation time '${String(observedAt)}' must be a recorded ISO-8601 timestamp (the source's observation time, never the processing clock)`,
    );
  }
  const parsed = Date.parse(observedAt);
  if (Number.isNaN(parsed)) {
    throw new EngineeringSignalError('SIGNAL_OBSERVED_AT_INVALID', `the observation time '${observedAt}' is not parseable`);
  }
  return observedAt;
}

/** Require the raw observation reference (non-empty kind + ref — preserved, never dereferenced). */
export function requireValidObservationRef(ref: SignalObservationReference): SignalObservationReference {
  if (ref === null || typeof ref !== 'object') {
    throw new EngineeringSignalError('SIGNAL_OBSERVATION_REF_INVALID', 'the raw observation reference is required (the provenance anchor)');
  }
  if (typeof ref.kind !== 'string' || ref.kind.trim() === '') {
    throw new EngineeringSignalError('SIGNAL_OBSERVATION_REF_INVALID', 'the raw observation reference requires a non-empty kind');
  }
  if (typeof ref.ref !== 'string' || ref.ref.trim() === '') {
    throw new EngineeringSignalError('SIGNAL_OBSERVATION_REF_INVALID', 'the raw observation reference requires a non-empty ref (the authority locator)');
  }
  return ref;
}

/**
 * Normalize a raw observation input into a {@link SignalOccurrence} —
 * the provenance-preserving derivation. The raw payload is PRESERVED
 * verbatim; the reference is PRESERVED; the severity/source/time are
 * validated against the closed vocabularies. A failure observation can
 * never be dropped or softened here (the no-silent-healthy invariant).
 */
export function normalizeObservation(
  input: RawObservationInput,
  identity: SignalIdentity,
  clock: () => Date,
): SignalOccurrence {
  const source = requireValidSource(input.source);
  const severity = requireValidSeverity(input.severity);
  const observedAt = requireValidObservedAt(input.observedAt);
  const observationRef = requireValidObservationRef(input.observationRef);
  if (input.raw === null || input.raw === undefined) {
    throw new EngineeringSignalError(
      'SIGNAL_RAW_PAYLOAD_REQUIRED',
      'the raw observation payload is required (a signal without its raw observation content is a free-floating signal)',
    );
  }
  if (typeof input.tenantId !== 'string' || input.tenantId.trim() === '') {
    throw new EngineeringSignalError('SIGNAL_TENANT_REQUIRED', 'the observation requires a non-empty tenant scope');
  }
  if (typeof input.projectId !== 'string' || input.projectId.trim() === '') {
    throw new EngineeringSignalError('SIGNAL_PROJECT_REQUIRED', 'the observation requires a non-empty project scope');
  }
  if (typeof input.environmentId !== 'string' || input.environmentId.trim() === '') {
    throw new EngineeringSignalError('SIGNAL_ENVIRONMENT_REQUIRED', 'the observation requires a non-empty environment scope');
  }
  if (typeof input.logicalFailureKey !== 'string' || input.logicalFailureKey.trim() === '') {
    throw new EngineeringSignalError('SIGNAL_LOGICAL_KEY_REQUIRED', 'the observation requires a non-empty logical failure key (the dedup classification)');
  }
  const releaseRef =
    input.releaseRef === undefined || input.releaseRef === null
      ? null
      : typeof input.releaseRef === 'string' && input.releaseRef.trim() !== ''
        ? input.releaseRef
        : null;
  const recordedAt = clock().toISOString();
  return {
    occurrenceId: deriveOccurrenceIdentity(identity, observationRef, observedAt),
    source,
    observedAt,
    severity,
    observationRef,
    raw: input.raw,
    releaseRef,
    recordedAt,
    convergenceReason: `occurrence of the logical failure '${input.logicalFailureKey}' observed by the '${source}' source at ${observedAt} (reference ${observationRef.kind}:${observationRef.ref}) — converged on the signal identity ${identity.signalId}`,
  };
}

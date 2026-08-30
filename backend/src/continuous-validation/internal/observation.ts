/**
 * WORK-064 Task 6a — observation recording + deterministic evaluation.
 *
 * THE NO-SILENT-HEALTHY RULE (spec/architecture/v1.1/evidence-provenance-
 * model.md §5): a missing observation is an EXPLICIT failure, never a
 * missing record. `evaluateObservation(expected, null)` is ALWAYS a
 * non-match. No matcher in the closed set can convert an absent or invalid
 * observation into a match.
 */
import type {
  ExpectedObservation,
  ObservationKind,
  ObservationProvenance,
  RecordObservationInput,
  ValidationObservation,
} from '../types.js';
import { OBSERVATION_KINDS, ValidationDomainError } from '../types.js';

function isObservationKind(value: unknown): value is ObservationKind {
  return typeof value === 'string' && (OBSERVATION_KINDS as readonly string[]).includes(value);
}

function assertNonEmpty(value: unknown, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationDomainError('OBSERVATION_PROVENANCE_INVALID', `${what} must be a non-empty string`);
  }
}

/**
 * Record a raw observation with COMPLETE provenance (run, journey, step,
 * environment, timestamp). Rejects empty identifiers and any missing
 * provenance field — an unattributed observation is unrepresentable.
 */
export function recordObservation(input: RecordObservationInput): ValidationObservation {
  if (!input || typeof input.id !== 'string' || input.id.trim() === '') {
    throw new ValidationDomainError('OBSERVATION_PROVENANCE_INVALID', 'observation id must be a non-empty string');
  }
  if (!isObservationKind(input.kind)) {
    throw new ValidationDomainError(
      'OBSERVATION_PROVENANCE_INVALID',
      `observation ${input.id}: kind must be one of ${OBSERVATION_KINDS.join(' | ')}`,
    );
  }
  const provenance = input.provenance as Partial<ObservationProvenance> | undefined;
  if (!provenance || typeof provenance !== 'object') {
    throw new ValidationDomainError(
      'OBSERVATION_PROVENANCE_INVALID',
      `observation ${input.id}: provenance is required`,
    );
  }
  assertNonEmpty(provenance.runId, `observation ${input.id}: provenance.runId`);
  assertNonEmpty(provenance.journeyId, `observation ${input.id}: provenance.journeyId`);
  assertNonEmpty(provenance.stepId, `observation ${input.id}: provenance.stepId`);
  assertNonEmpty(provenance.environmentId, `observation ${input.id}: provenance.environmentId`);
  assertNonEmpty(provenance.observedAt, `observation ${input.id}: provenance.observedAt`);
  return Object.freeze({
    id: input.id,
    kind: input.kind,
    value: input.value,
    provenance: Object.freeze({
      runId: provenance.runId,
      journeyId: provenance.journeyId,
      stepId: provenance.stepId,
      environmentId: provenance.environmentId,
      observedAt: provenance.observedAt,
    } as ObservationProvenance),
  });
}

/** Deterministic deep structural equality (no key-order sensitivity). */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEquals(item, b[index]));
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) {
      return false;
    }
    return aKeys.every((key) =>
      deepEquals(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

/**
 * Evaluate an actual observation against its expectation. Deterministic and
 * total:
 *
 *   - a MISSING observation (null) NEVER matches — the explicit
 *     missing-observation failure;
 *   - a kind mismatch NEVER matches;
 *   - the closed matcher set decides; there is no permissive matcher.
 */
export function evaluateObservation(
  expected: ExpectedObservation,
  actual: ValidationObservation | null,
): boolean {
  if (actual === null || actual === undefined) return false;
  if (actual.kind !== expected.kind) return false;
  switch (expected.matcher.kind) {
    case 'exists':
      return true;
    case 'equals':
      return deepEquals(actual.value, expected.matcher.value);
    case 'contains_text':
      return (
        typeof actual.value === 'string' && actual.value.includes(expected.matcher.text)
      );
    case 'status_code': {
      const value = actual.value;
      if (typeof value === 'number') return value === expected.matcher.status;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const status = (value as { status?: unknown }).status;
        return typeof status === 'number' && status === expected.matcher.status;
      }
      return false;
    }
    default:
      return false;
  }
}

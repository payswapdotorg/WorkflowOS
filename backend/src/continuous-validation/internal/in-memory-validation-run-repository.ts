/**
 * WORK-064 Task 8 — the in-memory ValidationRunRepository adapter.
 *
 * ARCHITECTURAL RULING (the repository mapping note §3 + the design doc §8):
 * repository inspection proved NO existing table represents validation state
 * and NO schema migration is authorized by WORK-064's current scope. This
 * IN-MEMORY adapter is therefore the repository boundary for this Work
 * Order: it satisfies the port for domain/composition purposes and is the
 * explicit, documented binding point for the future durable-persistence
 * decision (an ACR or an architect-authorized scope extension — never a
 * silent new table).
 *
 * Boundary behaviors:
 *   - deterministic create/read (provenance preserved byte-for-byte);
 *   - idempotent identifiers: re-creating the IDENTICAL record converges to
 *     one stored record; a same-id/different-content create is a typed
 *     conflict (no silent overwrite);
 *   - the no-secrets boundary: a run smuggling secret-shaped FIELDS
 *     (token/secret/password/cookie/credential/api-key keys, at any depth)
 *     is rejected at the persistence boundary — defense in depth under the
 *     type-level prohibition.
 */
import type { ValidationRun, ValidationRunRepository } from '../types.js';
import { ValidationDomainError } from '../types.js';

const SECRET_KEY_PATTERN = /token|secret|password|cookie|credential|api[-_]?key/i;

function scanForSecretKeys(value: unknown, path: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  for (const [key, child] of Object.entries(value)) {
    const keyPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      return keyPath;
    }
    const found = scanForSecretKeys(child, keyPath);
    if (found) return found;
  }
  return null;
}

/** The run's binding identity (everything a completion must preserve). */
function bindingIdentityOf(run: ValidationRun): string {
  return JSON.stringify({
    id: run.id,
    journeyId: run.journeyId,
    journeyName: run.journeyName,
    identity: run.identity,
    environmentId: run.environmentId,
    environmentKind: run.environmentKind,
    effectPolicy: run.effectPolicy,
    mode: run.mode,
    trigger: run.trigger,
    releaseRef: run.releaseRef,
    createdAt: run.createdAt,
  });
}

/** True iff `next` is exactly the completion of the admitted `previous`. */
function isCompletionOf(previous: ValidationRun, next: ValidationRun): boolean {
  return (
    previous.status === 'admitted' &&
    next.status === 'completed' &&
    bindingIdentityOf(previous) === bindingIdentityOf(next) &&
    next.outcome !== null
  );
}

/** The in-memory run repository (the documented non-durable adapter). */
export class InMemoryValidationRunRepository implements ValidationRunRepository {
  private readonly runs = new Map<string, ValidationRun>();

  async create(run: ValidationRun): Promise<ValidationRun> {
    if (!run || typeof run.id !== 'string' || run.id.trim() === '') {
      throw new ValidationDomainError('VALIDATION_RUN_CONFLICT', 'a stored run carries a non-empty id');
    }
    // The no-secrets persistence boundary (defense in depth):
    const secretPath = scanForSecretKeys(run, 'run');
    if (secretPath !== null) {
      throw new ValidationDomainError(
        'VALIDATION_RUN_SECRET_REJECTED',
        `the run record carries a secret-shaped field at ${secretPath} — credentials, tokens, and cookies are prohibited at the persistence boundary`,
      );
    }
    const existing = this.runs.get(run.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(run)) {
        // Same-key convergence: identical records are idempotent.
        return existing;
      }
      if (isCompletionOf(existing, run)) {
        // The ONE legitimate transition: the admitted run's completion
        // (same binding identity; only the lifecycle fields move).
        this.runs.set(run.id, run);
        return run;
      }
      throw new ValidationDomainError(
        'VALIDATION_RUN_CONFLICT',
        `run ${run.id} already exists with different content (no silent overwrite; the only transition is admitted → completed)`,
      );
    }
    this.runs.set(run.id, run);
    return run;
  }

  async getById(id: string): Promise<ValidationRun | null> {
    return this.runs.get(id) ?? null;
  }
}

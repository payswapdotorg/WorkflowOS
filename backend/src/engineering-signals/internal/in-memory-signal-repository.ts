/**
 * WORK-067 — the in-memory EngineeringSignalRepository adapter.
 *
 * The composition default in this Work Order (NO schema migration is
 * authorized — the WORK-064 run-repository / WORK-066 claim-store
 * precedent; the durable binding point is the documented future ACR at
 * the same port). The keyed uniqueness contract:
 *
 *   - the identity fingerprint is the uniqueness key;
 *   - a save for an EXISTING signalId with the SAME fingerprint MERGES:
 *     the occurrence union by occurrenceId (append-only, deterministic
 *     (observedAt, recordedAt, occurrenceId) order) + the later-updated
 *     correlation/assessment state (deterministic tie-break — the state
 *     is fully re-derivable through correlateToReleases);
 *   - a same-id/different-fingerprint save is the typed
 *     SIGNAL_IDENTITY_CONFLICT (fail closed);
 *   - the check-and-merge is SYNCHRONOUS (single-threaded JS: no await
 *     between the lookup and the mutation — the same atomicity argument
 *     as the WORK-066 in-memory claim store). The concurrent-actor
 *     PostgreSQL contract (the DATABASE constraint decides the winner)
 *     is proven by the real-PG two-actor integration suite against a
 *     test-schema table implementing this exact port.
 */
import { EngineeringSignalError } from '../types.js';
import type { EngineeringSignal, EngineeringSignalRepository } from '../types.js';
import { compareOccurrences } from './signal-identity.js';
import { deriveSignalTimelineAttributes } from './regression-assessment.js';

/** Merge the occurrence union (append-only, deterministic order). */
function mergeOccurrences(
  existing: readonly EngineeringSignal['occurrences'][number][],
  incoming: readonly EngineeringSignal['occurrences'][number][],
): EngineeringSignal['occurrences'] {
  const byId = new Map<string, EngineeringSignal['occurrences'][number]>();
  for (const occurrence of [...existing, ...incoming]) {
    const prior = byId.get(occurrence.occurrenceId);
    // Identical ids carry identical content (the deterministic derivation);
    // the first-seen record is kept (byte-identical under the contract).
    if (prior === undefined) byId.set(occurrence.occurrenceId, occurrence);
  }
  return [...byId.values()].sort(compareOccurrences);
}

/** Deterministic later-state-wins merge (the state is re-derivable). */
function laterStateWins<T extends { updatedAt: string; signalId: string }>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  // Deterministic tie-break (never insertion order): the lexicographically
  // greater canonical JSON wins — byte-stable under any interleaving.
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/** The in-memory adapter (the documented non-durable boundary). */
export class InMemoryEngineeringSignalRepository implements EngineeringSignalRepository {
  private readonly signals = new Map<string, EngineeringSignal>();
  private readonly byFingerprint = new Map<string, string>();

  async save(signal: EngineeringSignal): Promise<EngineeringSignal> {
    const existing = this.signals.get(signal.signalId);
    if (existing === undefined) {
      const priorId = this.byFingerprint.get(signal.identityFingerprint);
      if (priorId !== undefined && priorId !== signal.signalId) {
        // The same logical identity fingerprint already exists under a
        // different id — impossible under the deterministic derivation;
        // fail closed rather than fork the logical signal.
        throw new EngineeringSignalError(
          'SIGNAL_IDENTITY_CONFLICT',
          `the identity fingerprint ${signal.identityFingerprint} is already recorded under signal ${priorId} (a logical signal never forks)`,
        );
      }
      this.signals.set(signal.signalId, signal);
      this.byFingerprint.set(signal.identityFingerprint, signal.signalId);
      return signal;
    }
    if (existing.identityFingerprint !== signal.identityFingerprint) {
      throw new EngineeringSignalError(
        'SIGNAL_IDENTITY_CONFLICT',
        `signal ${signal.signalId} is recorded with identity fingerprint ${existing.identityFingerprint} but the save carries ${signal.identityFingerprint} (the same id cannot carry two logical identities)`,
      );
    }
    // The merged signal: the occurrence union (append-only, deterministic
    // order) + the timeline attributes RE-DERIVED from the merged set (the
    // derived attributes are pure functions of the occurrences — never a
    // stale snapshot) + the later correlation/assessment state (re-derivable
    // through correlateToReleases).
    const merged: EngineeringSignal = {
      ...laterStateWins(existing, signal),
      occurrences: mergeOccurrences(existing.occurrences, signal.occurrences),
      ...deriveSignalTimelineAttributes(mergeOccurrences(existing.occurrences, signal.occurrences)),
    };
    this.signals.set(merged.signalId, merged);
    return merged;
  }

  async findById(signalId: string): Promise<EngineeringSignal | null> {
    return this.signals.get(signalId) ?? null;
  }

  async findByIdentityFingerprint(fingerprint: string): Promise<EngineeringSignal | null> {
    const id = this.byFingerprint.get(fingerprint);
    return id === undefined ? null : (this.signals.get(id) ?? null);
  }

  async listByProject(projectId: string): Promise<readonly EngineeringSignal[]> {
    const out: EngineeringSignal[] = [];
    for (const signal of this.signals.values()) {
      if (signal.projectId === projectId) out.push(signal);
    }
    // Deterministic listing order.
    return out.sort((a, b) => (a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0));
  }
}

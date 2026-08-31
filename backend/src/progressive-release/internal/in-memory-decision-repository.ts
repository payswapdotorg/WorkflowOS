/**
 * WORK-069 §8 — the in-memory decision-repository adapter (the composition
 * default). NO schema migration is authorized by the Work Order
 * (`migrations: []` — the WORK-064 run-repository / WORK-066 claim-store /
 * WORK-067 signal-repository precedent); the durable binding point is a
 * future ACR at the same PORT, and the PostgreSQL keyed-uniqueness
 * contract is proven by the real-PG two-actor integration suite.
 *
 * Semantics (the port contract, mirrored by the PG fixture):
 *   - `save` inserts; a save whose decisionId exists with the SAME
 *     identity fingerprint converges to the stored record (idempotent);
 *   - a save whose decisionId exists with a DIFFERENT identity
 *     fingerprint is the typed PR_DECISION_IDENTITY_CONFLICT (the same id
 *     cannot carry two logical decisions — the deterministic id makes
 *     this a defense-in-depth check; the DATABASE constraint is the
 *     production arbiter);
 *   - the rollout history lists oldest-first (insertion order — the
 *     recorded rollout state).
 */
import type {
  ProgressiveReleaseDecisionRecord,
  ProgressiveReleaseDecisionRepository,
} from '../types.js';
import { ProgressiveReleaseError } from '../types.js';

interface StoredEntry {
  readonly record: ProgressiveReleaseDecisionRecord;
  readonly seq: number;
}

export class InMemoryProgressiveReleaseDecisionRepository implements ProgressiveReleaseDecisionRepository {
  private readonly byId = new Map<string, StoredEntry>();
  private seq = 0;

  async save(record: ProgressiveReleaseDecisionRecord): Promise<ProgressiveReleaseDecisionRecord> {
    const existing = this.byId.get(record.decisionId);
    if (existing !== undefined) {
      if (existing.record.identityFingerprint !== record.identityFingerprint) {
        throw new ProgressiveReleaseError(
          'PR_DECISION_IDENTITY_CONFLICT',
          `decision ${record.decisionId} is recorded with identity fingerprint ${existing.record.identityFingerprint} but the save carries ${record.identityFingerprint} (the same id cannot carry two logical decisions)`,
        );
      }
      // Idempotent convergence: the winner's record decides.
      return existing.record;
    }
    this.byId.set(record.decisionId, { record, seq: ++this.seq });
    return record;
  }

  async findById(decisionId: string): Promise<ProgressiveReleaseDecisionRecord | null> {
    return this.byId.get(decisionId)?.record ?? null;
  }

  async listForRollout(
    tenantId: string,
    projectId: string,
    releaseRef: string,
  ): Promise<readonly ProgressiveReleaseDecisionRecord[]> {
    const entries = [...this.byId.values()]
      .filter(
        (e) =>
          e.record.tenantId === tenantId &&
          e.record.projectId === projectId &&
          e.record.releaseRef === releaseRef,
      )
      .sort((a, b) => a.seq - b.seq);
    return entries.map((e) => e.record);
  }
}

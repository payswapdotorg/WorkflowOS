/**
 * WORK-066 — the in-memory ScheduledTriggerClaimStore adapter (the
 * composition default).
 *
 * ARCHITECTURAL RULING (WORK-066's parallel-execution metadata: `migrations:
 * []` — NO schema migration is authorized by this Work Order): the dedup
 * boundary is a PORT (the WORK-064 in-memory run-repository precedent). This
 * in-memory adapter is the repository boundary for this Work Order and the
 * explicit, documented binding point for the future durable decision (an ACR
 * or an architect-authorized scope extension — never a silent new table).
 * The PostgreSQL contract — keyed uniqueness where the DATABASE CONSTRAINT
 * (not an application race) decides the winner under true two-actor
 * concurrency — is proven by the real-PG integration suite against a
 * test-schema table implementing the same port.
 *
 * Boundary behaviors:
 *   - the claim's check-and-set is SYNCHRONOUS (single-statement semantics):
 *     two concurrent actors claiming the same identity cannot interleave
 *     between the check and the set — exactly one 'claimed';
 *   - re-delivery with the same identity + fingerprint → 'duplicate'
 *     (echoing the original claim — idempotent);
 *   - the same identity + a DIFFERENT fingerprint → 'conflict' (the same
 *     logical event cannot warrant two different classifications);
 *   - `record` fills the decision; `release` undoes an incomplete claim
 *     (admission dependency failure — the re-drive retries);
 *   - per-key independence: claims on DIFFERENT identities never interact
 *     (no global lock — duplicate suppression is keyed, not serialized).
 */
import type {
  ClaimRequest,
  ClaimResult,
  ScheduledTriggerClaim,
  ScheduledTriggerClaimStore,
  ScheduledTriggerDecisionRecord,
} from '../types.js';

interface StoredClaim {
  readonly contentFingerprint: string;
  readonly claimedAt: string;
  decision: ScheduledTriggerDecisionRecord | null;
}

/** The in-memory claim store (the documented non-durable adapter). */
export class InMemoryScheduledTriggerClaimStore implements ScheduledTriggerClaimStore {
  private readonly claims = new Map<string, StoredClaim>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async claim(request: ClaimRequest): Promise<ClaimResult> {
    const { schedulingId, contentFingerprint } = request;
    if (typeof schedulingId !== 'string' || schedulingId.trim() === '') {
      throw new Error('a claim requires a non-empty scheduling id');
    }
    // SYNCHRONOUS check-and-set: the atomic claim boundary (no await between
    // the check and the set — concurrent actors cannot interleave).
    const existing = this.claims.get(schedulingId);
    if (existing !== undefined) {
      if (existing.contentFingerprint !== contentFingerprint) {
        return {
          status: 'conflict',
          schedulingId,
          original: InMemoryScheduledTriggerClaimStore.toClaim(schedulingId, existing),
        };
      }
      return {
        status: 'duplicate',
        schedulingId,
        original: InMemoryScheduledTriggerClaimStore.toClaim(schedulingId, existing),
      };
    }
    this.claims.set(schedulingId, {
      contentFingerprint,
      claimedAt: this.now().toISOString(),
      decision: null,
    });
    return { status: 'claimed', schedulingId, original: null };
  }

  async record(schedulingId: string, decision: ScheduledTriggerDecisionRecord): Promise<void> {
    const existing = this.claims.get(schedulingId);
    if (existing === undefined) {
      throw new Error(`claim ${schedulingId} does not exist (record requires ownership)`);
    }
    if (existing.decision !== null && JSON.stringify(existing.decision) !== JSON.stringify(decision)) {
      throw new Error(`claim ${schedulingId} already carries a different decision (a decision is recorded exactly once)`);
    }
    existing.decision = decision;
  }

  async release(schedulingId: string): Promise<void> {
    // Release only an INCOMPLETE claim (a recorded decision is durable truth
    // for the lifetime of the store — the idempotent echo).
    const existing = this.claims.get(schedulingId);
    if (existing !== undefined && existing.decision === null) {
      this.claims.delete(schedulingId);
    }
  }

  async find(schedulingId: string): Promise<ScheduledTriggerClaim | null> {
    const existing = this.claims.get(schedulingId);
    return existing === undefined ? null : InMemoryScheduledTriggerClaimStore.toClaim(schedulingId, existing);
  }

  private static toClaim(schedulingId: string, stored: StoredClaim): ScheduledTriggerClaim {
    return {
      schedulingId,
      contentFingerprint: stored.contentFingerprint,
      claimedAt: stored.claimedAt,
      decision: stored.decision,
    };
  }
}

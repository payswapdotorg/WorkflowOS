/**
 * WORK-069 §8 — the in-memory decision-repository adapter (the composition
 * default). NO schema migration is authorized by the Work Order
 * (`migrations: []` — the WORK-064 run-repository / WORK-066 claim-store /
 * WORK-067 signal-repository precedent); the durable binding point is a
 * future ACR at the same PORT, and the PostgreSQL keyed-uniqueness
 * contract is proven by the real-PG two-actor integration suite.
 *
 * Semantics (the port contract, mirrored by the PG fixture):
 *   - `reserve` INSERTS (insert-only — no ungated single-shot save): the
 *     caller that reserves OWNS the governed consequence execution for the
 *     decision identity (the PR #108 architect-review correction: the
 *     record must be durable BEFORE any consequence executes). A reserve
 *     whose decisionId exists with the SAME identity fingerprint CONVERGES
 *     (the stored record decides; the concurrent loser executes nothing);
 *   - a reserve whose decisionId exists with a DIFFERENT identity
 *     fingerprint is the typed PR_DECISION_IDENTITY_CONFLICT (the same id
 *     cannot carry two logical decisions — the deterministic id makes
 *     this a defense-in-depth check; the DATABASE constraint is the
 *     production arbiter);
 *   - `completeDecision` is the pending → executed transition recording
 *     the consequence outcomes (a same-id re-completion converges
 *     idempotently; completing a never-reserved record is the typed
 *     PR_DECISION_COMPLETION_REJECTED);
 *   - the rollout history lists oldest-first (insertion order — the
 *     recorded rollout state).
 */
import type {
  DecisionConsequenceOutcomes,
  DecisionReservation,
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

  async reserve(record: ProgressiveReleaseDecisionRecord): Promise<DecisionReservation> {
    const existing = this.byId.get(record.decisionId);
    if (existing !== undefined) {
      if (existing.record.identityFingerprint !== record.identityFingerprint) {
        throw new ProgressiveReleaseError(
          'PR_DECISION_IDENTITY_CONFLICT',
          `decision ${record.decisionId} is recorded with identity fingerprint ${existing.record.identityFingerprint} but the reserve carries ${record.identityFingerprint} (the same id cannot carry two logical decisions)`,
        );
      }
      // Idempotent convergence: the winner's record decides — the loser of
      // the insert race executes NO consequence.
      return { status: 'converged', record: existing.record };
    }
    this.byId.set(record.decisionId, { record, seq: ++this.seq });
    return { status: 'reserved', record };
  }

  async completeDecision(
    decisionId: string,
    outcomes: DecisionConsequenceOutcomes,
  ): Promise<ProgressiveReleaseDecisionRecord> {
    const entry = this.byId.get(decisionId);
    if (entry === undefined) {
      throw new ProgressiveReleaseError(
        'PR_DECISION_COMPLETION_REJECTED',
        `decision ${decisionId} cannot be completed: no reserved record exists (the completion follows a reservation — never a bare write)`,
      );
    }
    if (entry.record.consequencePhase !== 'pending') {
      // Already executed — idempotent convergence (the stored record decides).
      return entry.record;
    }
    const completed: ProgressiveReleaseDecisionRecord = {
      ...entry.record,
      consequencePhase: 'executed',
      signalOutcomes: [...outcomes.signalOutcomes],
      rollback: outcomes.rollback,
    };
    this.byId.set(decisionId, { record: completed, seq: entry.seq });
    return completed;
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

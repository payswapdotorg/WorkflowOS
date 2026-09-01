/**
 * V2-014 — duplicate-attestation convergence by stable identity
 * (execution-attestation.md: repeated delivery of the same attestation MUST
 * converge by its stable attestation/execution identity).
 *
 * The in-memory ledger is the REFERENCE composition (the transport/ingestion
 * dedup surface). It is explicitly NOT durable run/evidence persistence —
 * that authority belongs to the run lifecycle Work Order, which will
 * reference the merged attestation contract. The clock is injected.
 */
import type { AttestationIngestionOutcome, ExecutionAttestation, UtcTimestamp } from '../types.js';

/** In-memory attestation ingestion ledger (deterministic, injected clock). */
export class InMemoryAttestationLedger {
  private readonly firstDelivery = new Map<string, { firstSeenAt: string; deliveries: number }>();

  ingest(attestation: ExecutionAttestation, at: UtcTimestamp): AttestationIngestionOutcome {
    const attestationId = attestation.attestationId;
    const existing = this.firstDelivery.get(attestationId);
    if (existing === undefined) {
      this.firstDelivery.set(attestationId, { firstSeenAt: at, deliveries: 1 });
      return { kind: 'accepted', attestationId, firstSeenAt: at, deliveries: 1 };
    }
    existing.deliveries += 1;
    return { kind: 'duplicate', attestationId, firstSeenAt: existing.firstSeenAt, deliveries: existing.deliveries };
  }

  /** The stable identity of an already-ingested attestation (or null). */
  find(attestationId: string): AttestationIngestionOutcome | null {
    const existing = this.firstDelivery.get(attestationId);
    if (existing === undefined) {
      return null;
    }
    return { kind: 'duplicate', attestationId, firstSeenAt: existing.firstSeenAt, deliveries: existing.deliveries };
  }
}

/**
 * In-memory single-use nonce replay registry (the reference ReplayRegistry
 * port implementation; deterministic, scoped to the exact
 * (run, attempt, nonce) binding).
 */
export class InMemoryReplayRegistry {
  private readonly consumed = new Set<string>();

  isConsumed(binding: { runId: string; attemptId: number; nonce: string }): boolean {
    return this.consumed.has(replayKey(binding));
  }

  consume(binding: { runId: string; attemptId: number; nonce: string }): void {
    this.consumed.add(replayKey(binding));
  }
}

function replayKey(binding: { runId: string; attemptId: number; nonce: string }): string {
  return `${binding.runId}|${String(binding.attemptId)}|${binding.nonce}`;
}

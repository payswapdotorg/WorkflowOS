/**
 * V2-011 — the reference proposal store + deterministic source factories.
 *
 * The store port (types.ts) keeps proposal persistence pluggable: durable
 * storage is a later, separately-owned concern; this in-memory store is
 * the reference composition used by tests and the dogfooding harness
 * (the exact V2-006/V2-010 precedent). The factories mirror the house
 * deterministic-source discipline (sequential ids, stepping clock — zero
 * wall clock, zero randomness).
 */
import type { OptimizationProposal, OptimizationProposalStore } from '../types.js';

/** An isolated in-memory optimization-proposal store (insertion order). */
export class InMemoryOptimizationProposalStore implements OptimizationProposalStore {
  private readonly proposals = new Map<string, OptimizationProposal>();

  put(proposal: OptimizationProposal): void {
    this.proposals.set(proposal.id, proposal);
  }

  get(proposalId: string): OptimizationProposal | undefined {
    return this.proposals.get(proposalId);
  }

  list(): readonly OptimizationProposal[] {
    return [...this.proposals.values()];
  }
}

/** A deterministic sequential id factory: `${prefix}_1`, `${prefix}_2`, … */
export function createSequentialIdFactory(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}_${(counter += 1)}`;
}

/**
 * A deterministic stepping clock: first call returns `startMs`, each further
 * call advances by `stepMs` (test/dogfooding determinism — never a wall
 * clock).
 */
export function createSteppingClock(startMs: number, stepMs: number): () => number {
  let ticks = 0;
  return () => startMs + ticks++ * stepMs;
}

/**
 * V2-006 — the reference session store + deterministic source factories.
 *
 * The store port (types.ts) keeps session persistence pluggable: durable
 * storage is a later, separately-owned concern; this in-memory store is the
 * reference composition used by tests and the dogfooding harness. The
 * factories mirror the node-capability deterministic-source precedent
 * (sequential ids, stepping clock — zero wall clock, zero randomness).
 */
import type { TeachingSession, TeachingSessionStore } from '../types.js';

/** An isolated in-memory TeachingSession store (identity-keyed). */
export class InMemoryTeachingSessionStore implements TeachingSessionStore {
  private readonly sessions = new Map<string, TeachingSession>();

  put(session: TeachingSession): void {
    this.sessions.set(session.id, session);
  }

  get(sessionId: string): TeachingSession | undefined {
    return this.sessions.get(sessionId);
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

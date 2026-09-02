/**
 * V2-010 — the reference session store + deterministic source factories.
 *
 * The store port (types.ts) keeps session persistence pluggable: durable
 * storage is a later, separately-owned concern; this in-memory store is the
 * reference composition used by tests and the dogfooding harness (the exact
 * V2-006 precedent). The factories mirror the house deterministic-source
 * discipline (sequential ids, stepping clock — zero wall clock, zero
 * randomness).
 */
import type { ReverseTeachingSession, ReverseTeachingSessionStore } from '../types.js';

/** An isolated in-memory reverse-teaching session store (identity-keyed). */
export class InMemoryReverseTeachingSessionStore implements ReverseTeachingSessionStore {
  private readonly sessions = new Map<string, ReverseTeachingSession>();

  put(session: ReverseTeachingSession): void {
    this.sessions.set(session.id, session);
  }

  get(sessionId: string): ReverseTeachingSession | undefined {
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

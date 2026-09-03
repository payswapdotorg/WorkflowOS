/**
 * V2-012 — deep-freeze (immutability by construction).
 *
 * Every marketplace record handed out by the service is DEEP-FROZEN: a
 * listing revision, its offers and its trust metadata are immutable in
 * place (constitution §19 discipline — a maintenance update is an explicit
 * NEW revision, never an in-place mutation). Mirrors the V2-011
 * internal/immutable.ts discipline.
 */

/** Recursively freeze a value (objects, arrays, nested records). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

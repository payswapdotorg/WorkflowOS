/**
 * V2-010 — the local immutability helpers (module-private, mirroring the
 * teaching-sessions / agent-roles precedent: each pure domain module keeps
 * its own tiny frozen-state utility; sibling internals are never imported).
 */

/** Recursively freeze a JSON-shaped object (teaching state is copy-on-write). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Recursively clone a JSON-shaped object (snapshots stay un-aliased). */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return out as T;
}

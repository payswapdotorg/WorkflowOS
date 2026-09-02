/**
 * V2-006 — deep-clone/deep-freeze helpers.
 *
 * The teaching session deep-freezes its pinned document snapshot and its
 * derived lesson: teaching is a read-only view, and every object the service
 * hands out is structurally immutable (assignment throws in strict mode).
 * Sessions/documents are JSON values, so JSON cloning is lossless here.
 */

/** Structural deep clone for JSON-safe values (the module's data model). */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Recursively freeze a JSON-safe value (plain objects and arrays). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
    }
    Object.freeze(value);
  }
  return value;
}

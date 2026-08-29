/**
 * WORK-048 (architect review correction, PR #76) — the read-state model for
 * every authoritative surface the Workbench renders.
 *
 * A read against a backend authority is ALWAYS exactly one of:
 *
 *   { status: 'loading' }          — the request is in flight; NOTHING may be
 *                                     claimed about the data yet;
 *   { status: 'success', data }    — the authority ANSWERED; `data` is the
 *                                     authoritative answer. success([]) is a
 *                                     GENUINE empty result — never an error
 *                                     in disguise;
 *   { status: 'error', message }   — the authority could not be reached or
 *                                     refused the request. This MUST render
 *                                     as an explicit error. It MUST NEVER
 *                                     degrade into an empty result: the
 *                                     Workbench must not silently turn
 *                                     "I don't know" into "I know there are
 *                                     zero records" (provenance loss at the
 *                                     presentation boundary).
 *
 * This module is presentation-only plumbing: it owns no authority, caches
 * nothing, evaluates nothing, and mutates nothing. The backend remains the
 * sole authority; this type only makes the outcome of each read explicit so
 * the UI cannot confuse a failed read with a successful empty one.
 */

export type ReadState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly message: string };

/** The initial state of every read (in flight; nothing claimed). */
export function readLoading<T>(): ReadState<T> {
  return { status: 'loading' };
}

/**
 * The human-readable reason of a failed read — the api client's own error
 * message (which surfaces the backend's response), never a fabricated one.
 */
export function readReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'request failed';
}

/**
 * Settle a promise into a ReadState WITHOUT ever swallowing the failure:
 * fulfillment becomes success(data) and rejection becomes error(message) —
 * a rejection can no longer be confused with legitimate empty data at the
 * call site (the defect the architect's review found in loadAll()'s
 * `.catch(() => null)` / `.catch(() => [])` degradation).
 */
export function settleRead<T>(promise: Promise<T>): Promise<ReadState<T>> {
  return promise.then(
    (data): ReadState<T> => ({ status: 'success', data }),
    (error): ReadState<T> => ({ status: 'error', message: readReason(error) }),
  );
}

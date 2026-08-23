/**
 * WorkflowOS Companion — shared constants + handoff deep-link parsing.
 *
 * Deep-link format (§20): the WorkflowOS SPA navigates to
 *
 *   <workflowos-origin>/companion/handoff#ref=<one-time-opaque-ref>&exec=<executionId>
 *
 * The fragment is NEVER sent to the server. It contains ONLY the one-time
 * opaque handoff reference (+ execution id for the page's own status
 * display) — never the prompt, never the callback token.
 */

export const HANDOFF_PATH_PREFIX = '/companion/handoff';
export const COMPANION_VERSION = '0.1.0';

/** DOM events used by the WorkflowOS SPA ⇄ content-script install handshake. */
export const DOM_EVENT_PING = 'workflowos:companion-ping';
export const DOM_EVENT_PONG = 'workflowos:companion-pong';
export const DOM_EVENT_STATUS = 'workflowos:companion-status';

/** Parsed handoff fragment. */
export interface HandoffFragment {
  /** One-time opaque handoff reference. */
  readonly ref: string;
  /** Execution id (optional; used for the page's status polling only). */
  readonly executionId?: string;
}

/**
 * Parse `#ref=…&exec=…` from a URL hash. Returns null when no ref is
 * present. Strict validation: refs must look like opaque tokens
 * (`wfht_` + hex) — anything else is rejected rather than passed along.
 */
export function parseHandoffFragment(hash: string): HandoffFragment | null {
  if (!hash || !hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const ref = params.get('ref');
  if (!ref) return null;
  if (!/^wfht_[0-9a-f]+$/.test(ref)) return null;
  const executionId = params.get('exec') ?? undefined;
  return { ref, executionId: executionId || undefined };
}

/** True when a URL is a WorkflowOS companion handoff page. */
export function isHandoffPage(pathname: string): boolean {
  return pathname === HANDOFF_PATH_PREFIX || pathname.startsWith(HANDOFF_PATH_PREFIX + '/');
}

/** Build the fragment string (used by tests; the SPA builds its own links). */
export function buildHandoffFragment(ref: string, executionId?: string): string {
  const params = new URLSearchParams({ ref });
  if (executionId) params.set('exec', executionId);
  return `#${params.toString()}`;
}

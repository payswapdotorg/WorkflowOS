/**
 * WORK-029: Z.ai DOM selectors — the ONLY place Z.ai DOM knowledge lives.
 *
 * Observed contract (2026-08-24, chat.z.ai unauthenticated view — see
 * README.md): the app is a React SPA with stable aria-labels on interactive
 * controls and a stable textarea id. Strategy:
 *
 *   1. Prefer semantic anchors: element id, aria-label, role, placeholder,
 *      accessible name, button[type=submit].
 *   2. Fallback chains per target — every finder walks strategies in order
 *      and reports confidence so the runtime can BLOCK safely ("Z.ai UI
 *      changed") instead of clicking arbitrary controls.
 *   3. NO nth-child chains, NO generated class names, NO coordinates.
 *
 * When Z.ai ships a coding-agent UI change, update THIS FILE ONLY.
 */

/** A single selector strategy with a human-readable description. */
export interface SelectorStrategy {
  readonly describe: string;
  /** Returns candidate elements in priority order. */
  find: (doc: Document) => Element[];
}

/** Resolution outcome with confidence for safe-fail behavior. */
export interface SelectorMatch<T extends HTMLElement = HTMLElement> {
  readonly element: T | null;
  readonly confidence: 'high' | 'medium' | 'none';
  readonly via: string | null;
}

// --- Composer (prompt input) ---------------------------------------------

export const COMPOSER: readonly SelectorStrategy[] = [
  // Observed 2026-08-24: <textarea id="chat-input" placeholder="How can I help you today?">
  { describe: 'textarea#chat-input', find: (d) => [...d.querySelectorAll('textarea#chat-input')] },
  {
    describe: 'textarea[placeholder*=How can I help]',
    find: (d) => [...d.querySelectorAll('textarea[placeholder*="How can I help" i]')],
  },
  {
    describe: 'main textarea with any placeholder',
    find: (d) => [...d.querySelectorAll('form textarea[placeholder], main textarea, [role=form] textarea')],
  },
];

// --- Send action -----------------------------------------------------------

export const SEND_CONTROL: readonly SelectorStrategy[] = [
  // Observed: div[aria-label="Send Message"] wrapping button[type=submit]
  // (disabled while the composer is empty).
  {
    describe: 'div[aria-label="Send Message"] button',
    find: (d) => [...d.querySelectorAll('div[aria-label="Send Message"] button')],
  },
  {
    describe: 'button[aria-label*=Send]',
    find: (d) => [...d.querySelectorAll('button[aria-label*="Send" i]')],
  },
  {
    describe: 'form button[type=submit]',
    find: (d) => [...d.querySelectorAll('form button[type=submit]:not([disabled])')],
  },
];

// --- New conversation ------------------------------------------------------

export const NEW_CHAT: readonly SelectorStrategy[] = [
  // Observed: div[aria-label="New Chat"] (sidebar control).
  { describe: 'div[aria-label="New Chat"]', find: (d) => [...d.querySelectorAll('div[aria-label="New Chat"]')] },
  {
    describe: '[aria-label*=New [Cc]hat]',
    find: (d) => [...d.querySelectorAll('[aria-label*="New Chat" i], [aria-label*="New chat" i]')],
  },
];

// --- Coding / agent mode ---------------------------------------------------

export const CODING_MODE: readonly SelectorStrategy[] = [
  // Observed: <button>ZCode</button> — the provider's coding-agent mode.
  { describe: 'button named ZCode', find: (d) => [...d.querySelectorAll('button')].filter((b) => /^zcode$/i.test((b.textContent ?? '').trim())) },
  {
    describe: '[aria-label*=ZCode i]',
    find: (d) => [...d.querySelectorAll('[aria-label*="ZCode" i]')],
  },
];

// --- Model selector ----------------------------------------------------------

export const MODEL_SELECTOR: readonly SelectorStrategy[] = [
  // Observed: button[aria-label="Select a model"] (label text e.g. GLM-4.7).
  { describe: 'button[aria-label="Select a model"]', find: (d) => [...d.querySelectorAll('button[aria-label="Select a model"]')] },
];

// --- Login wall ------------------------------------------------------------

export const LOGIN_WALL: readonly SelectorStrategy[] = [
  // Observed: "Sign in" buttons rendered when unauthenticated.
  { describe: 'button named Sign in', find: (d) => [...d.querySelectorAll('button')].filter((b) => /^sign in$/i.test((b.textContent ?? '').trim())) },
  { describe: '[aria-label*=Sign in i]', find: (d) => [...d.querySelectorAll('[aria-label*="Sign in" i]')] },
];

// --- Transcript / results region -------------------------------------------

export const TRANSCRIPT: readonly SelectorStrategy[] = [
  // The authenticated transcript structure was NOT observable during the
  // 2026-08-24 inspection (requires a signed-in session). These strategies
  // target conventional conversation-region semantics; confidence gating
  // keeps behavior safe when none match (BLOCKED, never arbitrary clicks).
  { describe: 'region role=log', find: (d) => [...d.querySelectorAll('[role="log"]')] },
  { describe: 'data-testid chat-history', find: (d) => [...d.querySelectorAll('[data-testid="chat-history"], [data-testid="conversation"]')] },
  { describe: 'main landmark', find: (d) => [...d.querySelectorAll('main')] },
];

// --- Error surfaces ----------------------------------------------------------

/** Visible provider error surfaces (rate limit, generation failed, network). */
export const ERROR_SURFACES: readonly SelectorStrategy[] = [
  { describe: 'role=alert', find: (d) => [...d.querySelectorAll('[role="alert"]')] },
  { describe: 'data-testid error', find: (d) => [...d.querySelectorAll('[data-testid="error"], [data-testid="error-banner"]')] },
];

/** Error text patterns → classification (failure vs session-expiry block). */
export const SESSION_EXPIRY_PATTERN = /sign in|log in again|session (has )?expired|not authenticated/i;
export const RATE_LIMIT_PATTERN = /rate limit|too many requests|quota/i;
export const HARD_FAILURE_PATTERN = /failed|error occurred|something went wrong|network error|unavailable/i;

/** Text markers a visible confirmation prompt may carry (§24 blocked). */
export const CONFIRMATION_PATTERN = /confirm|approve|allow|permission|are you sure/i;

// --- Resolution -------------------------------------------------------------

/** Walk strategies; first hit wins. Earlier strategies = higher confidence. */
export function resolve<T extends HTMLElement>(
  strategies: readonly SelectorStrategy[],
  doc: Document,
): SelectorMatch<T> {
  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i]!;
    const candidates = strategy
      .find(doc)
      .filter((el): el is T => el instanceof HTMLElement);
    const visible = candidates.find((el) => isVisible(el));
    if (visible) {
      return {
        element: visible,
        confidence: i === 0 ? 'high' : 'medium',
        via: strategy.describe,
      };
    }
  }
  return { element: null, confidence: 'none', via: null };
}

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden')) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  // NOTE: layout-based checks are intentionally avoided — headless test
  // environments (jsdom) report zero rects. Semantic hiding (hidden attr,
  // computed style) is the visibility contract.
  return true;
}

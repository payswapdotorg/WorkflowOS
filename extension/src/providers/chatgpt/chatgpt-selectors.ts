/**
 * WORK-030: ChatGPT DOM selectors — the ONLY place ChatGPT DOM knowledge
 * lives.
 *
 * CONTRACT CONFIDENCE (see README.md — observed 2026-08-24 from current
 * public sources; live inspection was blocked from the build environment by
 * the provider's edge firewall):
 *
 *   HIGH confidence (multiple independent current sources):
 *     - composer: div#prompt-textarea[contenteditable] (ProseMirror) — the
 *       historical textarea#prompt-textarea kept as a fallback strategy
 *     - send: button[data-testid="send-button"]
 *     - generating: button[data-testid="stop-button"] (streaming marker)
 *     - conversations: https://chatgpt.com/c/<uuid>
 *   MEDIUM confidence (conventional, confidence-gated):
 *     - new chat: the chatgpt.com ROOT is the fresh-composer surface (new
 *       chat action also exists in the sidebar)
 *     - assistant messages: [data-message-author-role="assistant"]
 *     - login wall: /auth/login redirect · "Log in"/"Sign up" buttons
 *
 * Every finder walks strategies in order; low/none confidence BLOCKS safely
 * ("ChatGPT UI changed; automatic execution paused.") — the adapter never
 * guesses at send/model/confirmation controls (§31). No nth-child, no
 * generated classes, no coordinates.
 */

export interface SelectorStrategy {
  readonly describe: string;
  find: (doc: Document) => Element[];
}

export interface SelectorMatch<T extends HTMLElement = HTMLElement> {
  readonly element: T | null;
  readonly confidence: 'high' | 'medium' | 'none';
  readonly via: string | null;
}

// --- Surface detection (WORK-030 PR #33 review) ------------------------------
//
// The product distinguishes Chat (conversational), Work, and Codex (the
// coding environment at chatgpt.com/codex — CONFIRMED from OpenAI's own
// product pages; UI anchors below are confidence-graded in the README).

/** HIGH confidence: the Codex web app path (official product URL). */
export const CODEX_URL_PATTERN = /^\/codex(\/|$)/;
/** MEDIUM confidence: Work surface path. */
export const WORK_URL_PATTERN = /^\/work(\/|$)/;
/** Chat conversations: /c/<uuid>; the root is the fresh Chat composer. */
export const CHAT_URL_PATTERN = /^\/?$|^\/c\//;

/** Codex surface anchors (MEDIUM — "New task" flow per product docs). */
export const CODEX_SURFACE: readonly SelectorStrategy[] = [
  {
    describe: 'New task control (Codex)',
    find: (d) =>
      [...d.querySelectorAll('button, a[role="button"], [data-testid]')].filter((el) =>
        /^new task$/i.test((el.textContent ?? '').trim()),
      ),
  },
  {
    describe: '[data-testid*=codex i]',
    find: (d) => [...d.querySelectorAll('[data-testid*="codex" i]')],
  },
];

/** Conversational Chat surface anchors (the composer itself proves Chat). */
export const CHAT_SURFACE: readonly SelectorStrategy[] = COMPOSER_STRATEGIES();

function COMPOSER_STRATEGIES() {
  // Late-bound to avoid declaration-order issues; same shape as COMPOSER.
  return [
    {
      describe: 'div#prompt-textarea[contenteditable]',
      find: (d: Document) => [...d.querySelectorAll('#prompt-textarea[contenteditable="true"]')],
    },
    {
      describe: 'textarea#prompt-textarea',
      find: (d: Document) => [...d.querySelectorAll('textarea#prompt-textarea')],
    },
  ];
}

// --- Composer (prompt input) ---------------------------------------------

export const COMPOSER: readonly SelectorStrategy[] = [
  // Current product: ProseMirror contenteditable div#prompt-textarea.
  {
    describe: 'div#prompt-textarea[contenteditable]',
    find: (d) => [...d.querySelectorAll('#prompt-textarea[contenteditable="true"]')],
  },
  // Historical form (kept as an explicit fallback, medium confidence).
  {
    describe: 'textarea#prompt-textarea',
    find: (d) => [...d.querySelectorAll('textarea#prompt-textarea')],
  },
  {
    describe: 'form [contenteditable=true] with id containing prompt',
    find: (d) => [...d.querySelectorAll('form [id*="prompt" i][contenteditable="true"]')],
  },
];

// --- Send action -----------------------------------------------------------

export const SEND_CONTROL: readonly SelectorStrategy[] = [
  // HIGH confidence: stable test id on the composer's send button.
  {
    describe: 'button[data-testid="send-button"]',
    find: (d) => [...d.querySelectorAll('button[data-testid="send-button"]')],
  },
  {
    describe: 'button[aria-label*=Send]',
    find: (d) => [...d.querySelectorAll('button[aria-label*="Send" i]')],
  },
  {
    describe: 'form button[type=submit]:not([disabled])',
    find: (d) => [...d.querySelectorAll('form button[type="submit"]:not([disabled])')],
  },
];

// --- New conversation --------------------------------------------------------

export const NEW_CHAT: readonly SelectorStrategy[] = [
  // The chatgpt.com ROOT is the fresh-composer surface (deterministic
  // new-task path — the adapter opens the root, never an existing /c/…).
  {
    describe: 'link to composer root',
    find: (d) => [...d.querySelectorAll('a[href="/"]')],
  },
  {
    describe: '[aria-label*=New chat i]',
    find: (d) => [...d.querySelectorAll('[aria-label*="New chat" i], [data-testid*="new-chat" i]')],
  },
];

// --- Model / agent mode ----------------------------------------------------

/**
 * Model/agent-mode controls. WORK-030 deliberately does NOT assume model
 * names, agent names, or mode semantics (§9/§10): these strategies only
 * DETECT conventional control surfaces for reporting; nothing is ever
 * auto-selected or substituted. Mode changes are visible user actions.
 */
export const MODE_CONTROL: readonly SelectorStrategy[] = [
  {
    describe: 'model selector button (aria-label)',
    find: (d) => [...d.querySelectorAll('button[aria-label*="Model" i]')],
  },
  {
    describe: '[data-testid*=model-switcher i]',
    find: (d) => [...d.querySelectorAll('[data-testid*="model-switcher" i]')],
  },
];

// --- Streaming marker (HIGH confidence) --------------------------------------

export const STREAMING_MARKER: readonly SelectorStrategy[] = [
  {
    describe: 'button[data-testid="stop-button"]',
    find: (d) => [...d.querySelectorAll('button[data-testid="stop-button"]')],
  },
];

// --- Login wall ---------------------------------------------------------------

export const LOGIN_WALL: readonly SelectorStrategy[] = [
  {
    describe: 'login wall container',
    find: (d) => [...d.querySelectorAll('[data-testid="login-button"], [data-testid="signup-button"]')],
  },
  {
    describe: 'button named Log in / Sign up',
    find: (d) =>
      [...d.querySelectorAll('button, a[role="button"]')].filter((b) =>
        /^(log in|sign up|get started)$/i.test((b.textContent ?? '').trim()),
      ),
  },
];

/** Login-wall URL paths (the product redirects unauthenticated visits). */
export const LOGIN_PATH_PATTERN = /^\/(auth\/login|auth\/signup|login|codex\/auth\/login)$/i;

// --- Transcript / result regions ------------------------------------------------

export const TRANSCRIPT: readonly SelectorStrategy[] = [
  // Conventional assistant-message anchors (MEDIUM confidence).
  {
    describe: 'assistant messages region',
    find: (d) => [...d.querySelectorAll('[data-message-author-role="assistant"]')],
  },
  { describe: 'region role=log', find: (d) => [...d.querySelectorAll('[role="log"]')] },
  { describe: 'main landmark', find: (d) => [...d.querySelectorAll('main')] },
];

// --- Error surfaces ----------------------------------------------------------

export const ERROR_SURFACES: readonly SelectorStrategy[] = [
  { describe: 'role=alert', find: (d) => [...d.querySelectorAll('[role="alert"]')] },
  {
    describe: 'data-testid error',
    find: (d) => [...d.querySelectorAll('[data-testid="error"], [data-testid="error-banner"]')],
  },
];

export const SESSION_EXPIRY_PATTERN = /log in|sign in|session (has )?expired|not authenticated|your session has expired/i;
export const RATE_LIMIT_PATTERN = /rate limit|too many requests|quota|usage limit/i;
export const HARD_FAILURE_PATTERN = /failed|error occurred|something went wrong|network error|unavailable|try again/i;

/** Ambiguous/consequential confirmation wording (§16 — stop + ask). */
export const CONFIRMATION_PATTERN = /confirm|approve|allow|permission|are you sure|proceed/i;

// --- Resolution -----------------------------------------------------------------

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

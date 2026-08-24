/**
 * WORK-031: Claude DOM selectors — the ONLY place ChatGPT DOM knowledge
 * lives.
 *
 * CONTRACT CONFIDENCE (see README.md — observed 2026-08-24; live
 * inspection was blocked from the build environment by a REGION restriction
 * — claude.com/app-unavailable-in-region; anchors assembled from current
 * public userscripts + official Claude Code docs):
 *
 *   HIGH confidence (multiple independent current sources):
 *     - composer: div.ProseMirror[contenteditable="true"] (claude.ai's
 *       ProseMirror editor; generic contenteditable fallbacks kept)
 *     - send: button[aria-label="Send message"] (case + substring variants)
 *     - generating: button[aria-label*="Stop"] ("Stop Claude response") —
 *       the streaming marker
 *     - conversations: https://claude.ai/chat/<uuid>
 *     - CODING SURFACE: https://claude.ai/code — "Claude Code on the web"
 *       (official docs: code.claude.com/docs/en/web-quickstart)
 *   MEDIUM confidence (conventional, confidence-gated):
 *     - new chat: the claude.ai ROOT / new-chat surface + sidebar "New Chat"
 *     - assistant messages: [data-testid="assistant-message"] +
 *       data-is-streaming attribute family
 *     - login wall: sign-in redirect · "Log in"/"Sign up" buttons
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
// coding environment at claude.ai/code — CONFIRMED from Anthropic's own
// product pages; UI anchors below are confidence-graded in the README).

/** HIGH confidence: the Codex web app path (official product URL). */
export const CLAUDE_CODE_URL_PATTERN = /^\/code(\/|$)/;
/** MEDIUM confidence: Work surface path. */
export const WORK_URL_PATTERN = /^\/projects(\/|$)/;
/** Chat conversations: /c/<uuid>; the root is the fresh Chat composer. */
export const CHAT_URL_PATTERN = /^\/?$|^\/new$|^\/chat\//;

/** Claude Code surface anchors (MEDIUM — cloud task flow per docs). */
export const CLAUDE_CODE_SURFACE: readonly SelectorStrategy[] = [
  {
    describe: 'New task control (Claude Code)',
    find: (d) =>
      [...d.querySelectorAll('button, a[role="button"], [data-testid]')].filter((el) =>
        /^new (task|session)$/i.test((el.textContent ?? '').trim()),
      ),
  },
  {
    describe: '[data-testid*=claude-code i], [data-testid*=code-]',
    find: (d) => [...d.querySelectorAll('[data-testid*="claude-code" i], [data-testid^="code-"]')],
  },
];

/** Conversational Chat surface anchors (the composer itself proves Chat). */
export const CHAT_SURFACE: readonly SelectorStrategy[] = COMPOSER_STRATEGIES();

function COMPOSER_STRATEGIES() {
  // Late-bound to avoid declaration-order issues; same shape as COMPOSER.
  return [
    {
      describe: 'div.ProseMirror[contenteditable=true]',
      find: (d: Document) => [...d.querySelectorAll('div.ProseMirror[contenteditable="true"]')],
    },
    {
      describe: 'form div[contenteditable=true] with id containing prompt',
      find: (d: Document) => [...d.querySelectorAll('form div[id*="prompt" i][contenteditable="true"]')],
    },
  ];
}

// --- Composer (prompt input) ---------------------------------------------

export const COMPOSER: readonly SelectorStrategy[] = [
  // Observed: claude.ai's ProseMirror composer (contenteditable div).
  {
    describe: 'div.ProseMirror[contenteditable=true]',
    find: (d) => [...d.querySelectorAll('div.ProseMirror[contenteditable="true"]')],
  },
  {
    describe: 'form div[contenteditable=true] with id containing prompt',
    find: (d) => [...d.querySelectorAll('form div[id*="prompt" i][contenteditable="true"]')],
  },
  // Generic contenteditable-in-form fallback (medium confidence).
  {
    describe: 'form [contenteditable=true][role=textbox]',
    find: (d) => [...d.querySelectorAll('form [contenteditable="true"][role="textbox"]')],
  },
];

// --- Send action -----------------------------------------------------------

export const SEND_CONTROL: readonly SelectorStrategy[] = [
  // HIGH confidence: observed aria-label ("Send message").
  {
    describe: 'button[aria-label="Send message"]',
    find: (d) => [...d.querySelectorAll('button[aria-label="Send message"]')],
  },
  {
    describe: 'button[data-testid="send-button"]',
    find: (d) => [...d.querySelectorAll('button[data-testid="send-button"]')],
  },
  {
    describe: 'button[aria-label*=Send i]',
    find: (d) => [...d.querySelectorAll('button[aria-label*="Send" i]')],
  },
];

// --- New conversation --------------------------------------------------------

export const NEW_CHAT: readonly SelectorStrategy[] = [
  // The claude.ai new-chat surface is the fresh composer (deterministic
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
  // Observed: the Stop control ("Stop Claude response") while generating.
  {
    describe: 'button[aria-label*="Stop"]',
    find: (d) => [...d.querySelectorAll('button[aria-label*="Stop" i]')],
  },
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
    describe: 'button named Log in / Sign up / Continue with',
    find: (d) =>
      [...d.querySelectorAll('button, a[role="button"]')].filter((b) =>
        /^(log in|sign up|sign in|get started)$/i.test((b.textContent ?? '').trim()),
      ),
  },
];

/** Login-wall URL paths (the product redirects unauthenticated visits). */
export const LOGIN_PATH_PATTERN = /^\/login$|^\/(login|code\/login)$/i;

// --- Transcript / result regions ------------------------------------------------

export const TRANSCRIPT: readonly SelectorStrategy[] = [
  // Observed assistant-message anchors (MEDIUM confidence).
  {
    describe: 'assistant messages (data-testid)',
    find: (d) => [...d.querySelectorAll('[data-testid="assistant-message"], [data-testid="user-message"]')],
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

export const SESSION_EXPIRY_PATTERN = /log in|sign in|session (has )?expired|not authenticated|your session has expired|log in to continue/i;
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

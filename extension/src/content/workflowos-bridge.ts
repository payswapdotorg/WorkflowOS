/**
 * WorkflowOS Companion — WorkflowOS-bridge content script.
 *
 * Runs ONLY on the configured WorkflowOS origin (manifest host permission).
 * Responsibilities (deliberately thin — §13):
 *   - answer the SPA's companion-install handshake (DOM ping/pong events);
 *   - detect the /companion/handoff page and relay the one-time opaque
 *     reference (URL fragment) to the background service worker;
 *   - relay the handoff result back to the page via a DOM status event.
 *
 * It contains NO WorkflowOS database/workflow/verification logic and never
 * sees any credential (the fragment ref is a one-time opaque token consumed
 * by the background worker).
 */
import {
  DOM_EVENT_PING,
  DOM_EVENT_PONG,
  DOM_EVENT_STATUS,
  COMPANION_VERSION,
  isHandoffPage,
  parseHandoffFragment,
} from '../shared/handoff.js';
import { message } from '../shared/messages.js';

// --- install handshake: the SPA pings, we answer + mark the document. ---

window.document.documentElement.setAttribute('data-workflowos-companion', COMPANION_VERSION);

window.addEventListener(DOM_EVENT_PING, () => {
  window.document.documentElement.setAttribute('data-workflowos-companion', COMPANION_VERSION);
  window.dispatchEvent(
    new CustomEvent(DOM_EVENT_PONG, { detail: { version: COMPANION_VERSION } }),
  );
});

// --- handoff relay ---

let lastRef: string | null = null;

function relayHandoffIfPresent(): void {
  if (!isHandoffPage(window.location.pathname)) return;
  const parsed = parseHandoffFragment(window.location.hash);
  if (!parsed || parsed.ref === lastRef) return;
  lastRef = parsed.ref;

  void chrome.runtime
    .sendMessage(
      message('WORKFLOWOS_HANDOFF', parsed.executionId ?? null, {
        ref: parsed.ref,
        origin: window.location.origin,
        executionId: parsed.executionId,
      }),
    )
    .then((response: unknown) => {
      // Surface the result to the page (no token material in either direction).
      window.dispatchEvent(
        new CustomEvent(DOM_EVENT_STATUS, {
          detail: response ?? { ok: false, error: 'no-response' },
        }),
      );
    })
    .catch(() => {
      window.dispatchEvent(
        new CustomEvent(DOM_EVENT_STATUS, {
          detail: { ok: false, error: 'companion-unavailable' },
        }),
      );
    });
}

// The SPA navigates client-side — watch hash changes + route changes.
window.addEventListener('hashchange', relayHandoffIfPresent);
window.addEventListener('popstate', relayHandoffIfPresent);
// Belt + braces: the initial document load on the handoff path, plus a short
// poll in case the SPA router lands on the path after document_idle.
relayHandoffIfPresent();
const poll = setInterval(relayHandoffIfPresent, 500);
setTimeout(() => clearInterval(poll), 30_000);

/**
 * WORK-029: jsdom test helpers — load the fixture INTO the test
 * environment's own document (same realm, so `instanceof HTMLElement`
 * checks in the selectors work) and drive the page runtime deterministically.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';

// jsdom lacks crypto.subtle in some vitest versions — polyfill from Node.
if (!(globalThis.crypto as { subtle?: unknown } | undefined)?.subtle) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixture');

/**
 * Load the fixture page into the CURRENT jsdom document (same realm).
 * The fixture's own <script> never runs here — `installFixtureComposer`
 * replicates its composer behavior, and variant params are applied directly
 * (mirroring fixture-agent.js).
 */
export function loadFixture(variant: Record<string, string> = {}): Document {
  const html = readFileSync(join(FIXTURE_DIR, 'index.html'), 'utf8');
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1]! : '';
  window.history.pushState({}, '', `/fixture${variant && Object.keys(variant).length ? `?${new URLSearchParams(variant)}` : ''}`);

  // Apply the login-wall variant (fixture-agent.js behavior).
  if (variant.wall === 'login') {
    const input = document.querySelector('#chat-input') as HTMLElement | null;
    const form = document.querySelector('#composer-form') as HTMLElement | null;
    const signin = document.querySelector('#signin-btn') as HTMLElement | null;
    if (input) input.hidden = true;
    if (form) form.hidden = true;
    if (signin) signin.hidden = false;
  }
  return document;
}

/**
 * Install the fixture agent's COMPOSER behavior under jsdom (the fixture
 * <script> does not run): enable send on input + count real submits.
 * Mirrors tests/zai/fixture/fixture-agent.js exactly.
 */
export function installFixtureComposer(doc: Document): void {
  const input = doc.querySelector('#chat-input') as HTMLTextAreaElement | null;
  const send = doc.querySelector('#send-btn') as HTMLButtonElement | null;
  if (!input || !send) return;
  input.addEventListener('input', () => {
    send.disabled = input.value.trim().length === 0;
  });
  send.addEventListener('click', () => {
    if (send.disabled) return;
    (window as unknown as { __zaiSubmits: number }).__zaiSubmits =
      ((window as unknown as { __zaiSubmits?: number }).__zaiSubmits ?? 0) + 1;
  });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Deterministic fake-agent driver: append a transcript message. */
export function agentMessage(
  doc: Document,
  text: string,
  state?: 'streaming' | 'done',
): void {
  const transcript = doc.querySelector('#transcript');
  if (!transcript) throw new Error('fixture transcript missing');
  const div = doc.createElement('div');
  div.className = 'msg assistant';
  if (state) div.setAttribute('data-state', state);
  div.textContent = text; // fixture content is text-only by design
  transcript.appendChild(div);
}

export function showError(doc: Document, text: string): void {
  const slot = doc.querySelector('#error-slot');
  const div = doc.createElement('div');
  div.setAttribute('role', 'alert');
  div.textContent = text;
  slot?.appendChild(div);
}

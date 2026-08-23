/**
 * WORK-030: jsdom test helpers — load the ChatGPT fixture page into the
 * test environment's own document (same realm so instanceof checks work)
 * and drive the page runtime deterministically. Mirrors tests/zai/helpers.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';

if (!(globalThis.crypto as { subtle?: unknown } | undefined)?.subtle) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixture');

export function loadFixture(variant: Record<string, string> = {}): Document {
  const html = readFileSync(join(FIXTURE_DIR, 'index.html'), 'utf8');
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1]! : '';
  window.history.pushState(
    {},
    '',
    `/fixture${variant && Object.keys(variant).length ? `?${new URLSearchParams(variant)}` : ''}`,
  );

  if (variant.wall === 'login') {
    const composer = document.querySelector('#prompt-textarea') as HTMLElement | null;
    const form = document.querySelector('#composer-form') as HTMLElement | null;
    const login = document.querySelector('#login-btn') as HTMLElement | null;
    if (composer) composer.hidden = true;
    if (form) form.hidden = true;
    if (login) login.hidden = false;
    window.history.replaceState({}, '', '/auth/login');
  }
  return document;
}

/**
 * Install the fixture agent's COMPOSER behavior under jsdom (the fixture
 * <script> does not run): enable send on input, count real submits, and
 * provide a minimal execCommand shim so the runtime's ProseMirror injection
 * path (selectAll + insertText) is exercised exactly as in Chromium.
 * Mirrors tests/chatgpt/fixture/fixture-agent.js.
 */
export function installFixtureComposer(doc: Document): void {
  const composer = doc.querySelector('#prompt-textarea') as HTMLElement | null;
  const send = doc.querySelector('#send-btn') as HTMLButtonElement | null;
  if (!composer || !send) return;

  const composerText = () => (composer.textContent ?? '').replace(/\u00a0/g, ' ');

  composer.addEventListener('input', () => {
    send.disabled = composerText().trim().length === 0;
  });

  send.addEventListener('click', () => {
    if (send.disabled) return;
    (window as unknown as { __cgptSubmits: number }).__cgptSubmits =
      ((window as unknown as { __cgptSubmits?: number }).__cgptSubmits ?? 0) + 1;
  });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function agentMessage(
  doc: Document,
  text: string,
  state?: 'streaming' | 'done',
): void {
  const transcript = doc.querySelector('#transcript');
  if (!transcript) throw new Error('fixture transcript missing');
  const div = doc.createElement('div');
  div.className = 'msg assistant';
  // Observed product anchor for message authorship.
  div.setAttribute('data-message-author-role', 'assistant');
  if (state) div.setAttribute('data-state', state);
  div.textContent = text;
  transcript.appendChild(div);
}

export function showError(doc: Document, text: string): void {
  const slot = doc.querySelector('#error-slot');
  const div = doc.createElement('div');
  div.setAttribute('role', 'alert');
  div.textContent = text;
  slot?.appendChild(div);
}

/** Toggle the fixture's streaming marker (stop-button visibility). */
export function setStreaming(doc: Document, streaming: boolean): void {
  const stop = doc.querySelector('#stop-btn') as HTMLElement | null;
  if (stop) stop.hidden = !streaming;
}

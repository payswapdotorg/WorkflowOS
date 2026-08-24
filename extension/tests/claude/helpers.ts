/**
 * WORK-031: jsdom test helpers — load the Claude fixture page into the
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

/** Fixture page kind: the conversational Chat page or the Codex coding page. */
export type FixturePage = 'chat' | 'claudeCode';

const PAGES: Record<FixturePage, { file: string; path: string; loginPath: string; logId: string }> = {
  chat: { file: 'index.html', path: '/', loginPath: '/login', logId: '#transcript' },
  claudeCode: { file: 'code.html', path: '/code/', loginPath: '/code/login', logId: '#task-log' },
};

/**
 * Load a fixture page into the CURRENT jsdom document (same realm).
 * `page` selects the surface: 'chat' (conversational) or 'claudeCode'
 * (coding-agent — the implementation target per WORK-031).
 */
export function loadFixture(
  variant: Record<string, string> = {},
  page: FixturePage = 'chat',
): Document {
  const meta = PAGES[page];
  const html = readFileSync(join(FIXTURE_DIR, meta.file), 'utf8');
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1]! : '';
  window.history.pushState(
    {},
    '',
    `${meta.path}${variant && Object.keys(variant).length ? `?${new URLSearchParams(variant)}` : ''}`,
  );

  if (variant.wall === 'login') {
    const composer = document.querySelector('#prompt-textarea') as HTMLElement | null;
    const form = document.querySelector('#composer-form') as HTMLElement | null;
    const login = document.querySelector('#login-btn') as HTMLElement | null;
    if (composer) composer.hidden = true;
    if (form) form.hidden = true;
    if (login) login.hidden = false;
    window.history.replaceState({}, '', meta.loginPath);
  }
  return document;
}

/**
 * Install the fixture agent's COMPOSER behavior under jsdom (the fixture
 * <script> does not run): enable send on input, count real submits, and
 * provide a minimal execCommand shim so the runtime's ProseMirror injection
 * path (selectAll + insertText) is exercised exactly as in Chromium.
 * Mirrors tests/claude/fixture/claude-chat-agent.js.
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
    (window as unknown as { __claudeSubmits: number }).__claudeSubmits =
      ((window as unknown as { __claudeSubmits?: number }).__claudeSubmits ?? 0) + 1;
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
  const transcript = doc.querySelector('#transcript, #task-log');
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

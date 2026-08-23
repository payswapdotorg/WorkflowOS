/**
 * WORK-030: ChatGPT page runtime — executes INSIDE the chatgpt.com page
 * (isolated-world content script). All ChatGPT DOM interaction lives here.
 *
 * Flow (§5–§19):
 *   attach(session) →
 *     1. login wall (buttons or /auth/login path) → BLOCKED "Please sign in
 *        to ChatGPT."
 *     2. composer discovery (confidence-gated; textarea OR contenteditable)
 *        → BLOCKED "ChatGPT UI changed…" when none
 *     3. sha256(prompt) === promptDigest identity check → BLOCKED (never
 *        submit a prompt that fails the check)
 *     4. if !promptSubmitted: inject EXACTLY (ProseMirror-safe path for
 *        contenteditable: focus → selectAll → execCommand('insertText') so
 *        the editor's own input pipeline updates app state; textarea path:
 *        native value setter + input event), read back + verify, submit ONCE
 *     5. record conversation URL (/c/<uuid>) as externalSessionRef (safe
 *        metadata only)
 *     6. observe the transcript region (scoped MutationObserver + light
 *        surface interval): progress → completion (multi-signal + debounce:
 *        quiet window + no stop-button streaming marker + stable text),
 *        visible errors → failed / rate-limited / session-expiry blocked,
 *        ambiguous confirmations → BLOCKED "ChatGPT requires user
 *        confirmation." (stop + ask, never auto-click)
 *   stop() disconnects everything. Reload-safe: re-attach with
 *   promptSubmitted=true NEVER re-injects — observe only (§19).
 *
 * SECURITY: textContent-only extraction (no innerHTML/eval); no cookie
 * access; no credentials; observations never carry WorkflowOS authority
 * outcomes; conversation-scoped (§18: observations stop when the URL leaves
 * the recorded conversation); every observation bound to executionId.
 */

import { message } from '../../shared/messages.js';

export type { ChatgptPageSession } from './chatgpt-types.js';
import type {
  ChatgptAttachResult,
  ChatgptObservation,
  ChatgptPageSession,
  ChatgptPhase,
} from './chatgpt-types.js';
import {
  COMPOSER,
  CONFIRMATION_PATTERN,
  ERROR_SURFACES,
  HARD_FAILURE_PATTERN,
  LOGIN_PATH_PATTERN,
  LOGIN_WALL,
  RATE_LIMIT_PATTERN,
  SESSION_EXPIRY_PATTERN,
  STREAMING_MARKER,
  TRANSCRIPT,
  resolve,
} from './chatgpt-selectors.js';

/** Completion stability window: transcript quiet before completing. */
const COMPLETION_QUIET_MS = 2500;
/** Bounded composer-discovery window while the SPA mounts. */
const DISCOVERY_TIMEOUT_MS = 20000;
const CONVERSATION_POLL_MS = 400;
const CONVERSATION_POLL_MAX = 15000;
/** Light surface-interval for portaled dialogs/errors (NOT page polling). */
const SURFACE_INTERVAL_MS = 1200;

interface RuntimeState {
  session: ChatgptPageSession;
  phase: ChatgptPhase;
  observer: MutationObserver | null;
  timers: Set<ReturnType<typeof setTimeout>>;
  conversationPath: string | null;
  lastTranscriptText: string;
  quietTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  injectedExecutionIds: Set<string>;
}

let state: RuntimeState | null = null;

type SendMessage = (msg: unknown) => Promise<unknown>;
let send: SendMessage = async (msg) => {
  void msg;
  return null;
};

export function bindTransport(transport: SendMessage): void {
  send = transport;
}

async function emitPhase(phase: ChatgptPhase, detail?: string): Promise<void> {
  if (state) state.phase = phase;
  await send(
    message('PROVIDER_STATUS', state?.session.executionId ?? null, { phase, detail }),
  );
}

async function emitObservation(observation: Omit<ChatgptObservation, 'executionId'>): Promise<void> {
  if (!state || state.stopped) return;
  const full: ChatgptObservation = { ...observation, executionId: state.session.executionId };
  const type =
    observation.kind === 'started' || observation.kind === 'progress'
      ? 'EXECUTION_PROGRESS'
      : observation.kind === 'completed'
        ? 'EXECUTION_COMPLETED'
        : observation.kind === 'failed'
          ? 'EXECUTION_FAILED'
          : 'EXECUTION_BLOCKED';
  await send(
    message(type, full.executionId, {
      output: full.output,
      branch: full.branch,
      commitRef: full.commitRef,
      pullRequestRef: full.pullRequestRef,
      testSummary: full.testSummary,
      externalSessionRef: full.externalSessionRef,
      reason: full.reason,
    }),
  );
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function appliesTo(provider: string): boolean {
  return provider === 'chatgpt';
}

export async function attach(session: ChatgptPageSession): Promise<ChatgptAttachResult> {
  // One automation session per execution; a stale runtime for a DIFFERENT
  // execution is stopped first (§18 — never observe across executions).
  if (state && state.session.executionId !== session.executionId) {
    await stop();
  }
  if (state && state.session.executionId === session.executionId && !state.stopped) {
    return { attached: true, phase: state.phase, detail: 'already-attached' };
  }

  state = {
    session,
    phase: 'connecting',
    observer: null,
    timers: new Set(),
    conversationPath: null,
    lastTranscriptText: '',
    quietTimer: null,
    stopped: false,
    injectedExecutionIds: new Set(),
  };

  await emitPhase('provider-detected');

  // 1. Login wall (§5): buttons OR the product's auth redirect path.
  const login = resolve(LOGIN_WALL, document);
  const composerMatch = resolve(COMPOSER, document);
  if ((login.element && !composerMatch.element) || LOGIN_PATH_PATTERN.test(location.pathname)) {
    await emitObservation({
      kind: 'blocked',
      reason: 'Please sign in to ChatGPT.',
      output: 'ChatGPT session is not authenticated.',
    });
    await emitPhase('blocked', 'login-required');
    await stop();
    return { attached: false, phase: 'blocked', detail: 'login-required' };
  }

  // 2. Composer discovery (bounded retry; confidence-gated §31).
  const composer = await waitForComposer();
  if (!composer) {
    await emitObservation({
      kind: 'blocked',
      reason: 'ChatGPT UI changed; automatic execution paused.',
      output: 'Composer element not found with known selectors.',
    });
    await emitPhase('blocked', 'composer-not-found');
    await stop();
    return { attached: false, phase: 'blocked', detail: 'composer-not-found' };
  }

  // 3. Digest identity check — mismatch means NEVER submit (§8).
  const digest = await sha256Hex(session.prompt);
  if (digest !== session.promptDigest) {
    await emitObservation({
      kind: 'blocked',
      reason: 'Prompt digest mismatch — submission refused.',
      output: `computed ${digest.slice(0, 12)}… ≠ expected ${session.promptDigest.slice(0, 12)}…`,
    });
    await emitPhase('blocked', 'digest-mismatch');
    await stop();
    return { attached: false, phase: 'blocked', detail: 'digest-mismatch' };
  }
  await emitPhase('prompt-ready');

  // 4. Inject exactly once (§11).
  if (!session.promptSubmitted && !state.injectedExecutionIds.has(session.executionId)) {
    const inserted = injectPrompt(composer.element, session.prompt);
    if (!inserted) {
      await emitObservation({
        kind: 'blocked',
        reason: 'ChatGPT UI changed; automatic execution paused.',
        output: 'Prompt insertion could not be verified (read-back mismatch).',
      });
      await emitPhase('blocked', 'insert-verification-failed');
      await stop();
      return { attached: false, phase: 'blocked', detail: 'insert-verification-failed' };
    }
    await emitPhase('prompt-inserted');

    const sent = submit();
    if (!sent) {
      await emitObservation({
        kind: 'blocked',
        reason: 'ChatGPT send control unavailable.',
        output: 'Send button was not actionable.',
      });
      await emitPhase('blocked', 'send-unavailable');
      await stop();
      return { attached: false, phase: 'blocked', detail: 'send-unavailable' };
    }
    state.injectedExecutionIds.add(session.executionId);
    await emitPhase('task-sent');
    await emitObservation({
      kind: 'started',
      externalSessionRef: location.pathname,
      output: 'Prompt submitted to ChatGPT.',
    });
  } else {
    // Reload/recovery (§19): task already submitted — observe only.
    await emitPhase('agent-running', 'recovery-observe-only');
  }

  // 5. Record the conversation URL once ChatGPT transitions to /c/<uuid>.
  void trackConversation();

  // 6. Observe the transcript.
  observeTranscript();

  return { attached: true, phase: state.phase };
}

async function waitForComposer(): Promise<{ element: HTMLElement } | null> {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline && state && !state.stopped) {
    const match = resolve(COMPOSER, document);
    if (match.element) return { element: match.element };
    await sleep(500);
  }
  return null;
}

/**
 * Insert the EXACT prompt and verify by read-back (§8).
 *
 * Two composer forms (both documented in README):
 *  - contenteditable (current product, ProseMirror): focus → selectAll →
 *    document.execCommand('insertText') so the editor's own input pipeline
 *    records the change (app state + send-enable). jsdom/test fallback sets
 *    textContent + fires input when execCommand is unavailable.
 *  - textarea (historical/fallback): native value setter + input event.
 *
 * Read-back compares NORMALIZED text (contenteditable represents newlines as
 * block elements and non-breaking spaces); byte-for-byte "where the browser
 * representation allows" per §8 — normalization is documented in the README.
 */
export function injectPrompt(composer: HTMLElement, prompt: string): boolean {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(composer, prompt);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    return composer.value === prompt;
  }
  // contenteditable path.
  const doc = composer.ownerDocument;
  if (typeof doc.execCommand === 'function') {
    composer.focus();
    // Select existing content, then replace through the editor pipeline.
    doc.execCommand('selectAll', false);
    const ok = doc.execCommand('insertText', false, prompt);
    if (!ok) return false;
  } else {
    // Test-environment fallback (jsdom has no execCommand): replace content
    // and notify through the input event — mirrors the fixture composer.
    composer.textContent = prompt;
    composer.dispatchEvent(
      new (composer.ownerDocument.defaultView?.InputEvent ?? Event)('input', {
        bubbles: true,
        inputType: 'insertText',
        data: prompt,
      } as InputEventInit),
    );
  }
  return normalizeEditorText(readEditorText(composer)) === normalizeEditorText(prompt);
}

/** Read the composer's current text (textarea value or editor content). */
function readEditorText(composer: HTMLElement): string {
  if (composer instanceof HTMLTextAreaElement) return composer.value;
  return readContentEditableText(composer);
}

/**
 * Extract an editor's text with correct line-break semantics: <br> and
 * block-element boundaries (div/p/…) contribute '\n' — raw textContent
 * DROPS them (execCommand('insertText') represents newlines as breaks in
 * Chromium), which would break the read-back verification.
 */
export function readContentEditableText(el: HTMLElement): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE && node instanceof Text) {
      out += node.data;
      return;
    }
    if (node.nodeName === 'BR') {
      out += '\n';
      return;
    }
    const isBlock = /^(DIV|P|LI|UL|OL|H[1-6])$/.test(node.nodeName);
    if (isBlock && out.length > 0 && !out.endsWith('\n')) out += '\n';
    node.childNodes.forEach(walk);
    if (isBlock && out.length > 0 && !out.endsWith('\n')) out += '\n';
  };
  el.childNodes.forEach(walk);
  return out;
}

/**
 * Normalize editor whitespace for comparison (see README limitations):
 * nbsp/zero-width removal, CRLF, and blank-line collapsing applied to BOTH
 * the inserted prompt and the read-back so the §8 verification is exact
 * under the browser's editor representation.
 */
export function normalizeEditorText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Click the send control (HIGH-confidence data-testid first). */
export function submit(): boolean {
  const byTestId = document.querySelectorAll('button[data-testid="send-button"]');
  for (const button of byTestId) {
    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.click();
      return true;
    }
  }
  const fallback = resolve(SEND_FALLBACK, document);
  if (fallback.element) {
    fallback.element.click();
    return true;
  }
  return false;
}

const SEND_FALLBACK = [
  {
    describe: 'button[aria-label*=Send]',
    find: (d: Document) => [...d.querySelectorAll('button[aria-label*="Send" i]')],
  },
] as const;

// --- conversation tracking (§7/§18) ------------------------------------------

async function trackConversation(): Promise<void> {
  const deadline = Date.now() + CONVERSATION_POLL_MAX;
  while (Date.now() < deadline && state && !state.stopped) {
    const path = location.pathname;
    if (/^\/c\//.test(path)) {
      state.conversationPath = path;
      await emitObservation({
        kind: 'progress',
        externalSessionRef: path,
        output: `ChatGPT conversation ${path}.`,
      });
      return;
    }
    await sleep(CONVERSATION_POLL_MS);
  }
}

function inConversationScope(): boolean {
  if (!state) return false;
  if (!state.conversationPath) return true; // not yet resolved — initial page
  return location.pathname === state.conversationPath;
}

// --- transcript observation (§12/§13/§14/§15/§16) ------------------------------

function observeTranscript(): void {
  if (!state || state.stopped) return;
  const region = resolve(TRANSCRIPT, document);
  const target =
    region.element?.parentElement && region.element.parentElement !== document.body
      ? region.element.parentElement
      : (region.element ?? document.body);
  state.observer = new MutationObserver(() => void onTranscriptMutation());
  state.observer.observe(target, { childList: true, subtree: true, characterData: true });
  // §12: light targeted surface check for portaled dialogs/error banners.
  const surfaceInterval = setInterval(() => void onTranscriptMutation(), SURFACE_INTERVAL_MS);
  state.timers.add(surfaceInterval as unknown as ReturnType<typeof setTimeout>);
  void onTranscriptMutation();
}

async function onTranscriptMutation(): Promise<void> {
  if (!state || state.stopped) return;
  if (!inConversationScope()) return; // user navigated elsewhere — never observe

  // §16: ambiguous/consequential confirmations → stop + ask, never auto-click.
  if (hasConfirmationPrompt()) {
    await emitObservation({
      kind: 'blocked',
      reason: 'ChatGPT requires user confirmation.',
      output: 'A confirmation prompt is visible; automatic execution paused.',
    });
    await emitPhase('blocked', 'user-confirmation-required');
    await stop();
    return;
  }

  // §14: visible provider errors.
  const errorText = visibleErrorText();
  if (errorText) {
    if (SESSION_EXPIRY_PATTERN.test(errorText)) {
      await emitObservation({
        kind: 'blocked',
        reason: 'ChatGPT session unavailable; please sign in again.',
        output: errorText.slice(0, 300),
      });
      await emitPhase('blocked', 'session-expired');
      await stop();
      return;
    }
    if (RATE_LIMIT_PATTERN.test(errorText)) {
      await emitObservation({
        kind: 'failed',
        reason: 'rate-limited',
        output: errorText.slice(0, 300),
      });
      await emitPhase('failed');
      await stop();
      return;
    }
    if (HARD_FAILURE_PATTERN.test(errorText)) {
      await emitObservation({
        kind: 'failed',
        output: errorText.slice(0, 300),
      });
      await emitPhase('failed');
      await stop();
      return;
    }
  }

  const text = transcriptText();
  if (!text || text === state.lastTranscriptText) return;
  const previous = state.lastTranscriptText;
  state.lastTranscriptText = text;

  const delta = text.slice(previous.length);
  const observations = extractRepositoryObservations(delta || text);

  if (isStreaming()) {
    await emitPhase('agent-running');
    await emitObservation({ kind: 'progress', ...observations, output: summarize(delta) });
    scheduleCompletionCheck();
  } else if (looksComplete(text)) {
    scheduleCompletionCheck();
  }
}

function scheduleCompletionCheck(): void {
  if (!state || state.stopped) return;
  if (state.quietTimer) clearTimeout(state.quietTimer);
  state.quietTimer = setTimeout(() => void checkCompletion(), COMPLETION_QUIET_MS);
  state.timers.add(state.quietTimer);
}

async function checkCompletion(): Promise<void> {
  if (!state || state.stopped) return;
  const text = transcriptText();
  if (isStreaming()) {
    scheduleCompletionCheck(); // still generating (stop-button visible)
    return;
  }
  if (text !== state.lastTranscriptText) {
    state.lastTranscriptText = text;
    await onTranscriptMutation();
    return;
  }
  // §13 multi-signal completion: quiet window elapsed + no streaming marker
  // + text stable since the last mutation. Never a single weak signal.
  const observations = extractRepositoryObservations(text);
  await emitObservation({
    kind: 'completed',
    ...observations,
    output: summarize(text),
  });
  await emitPhase('completed');
  await stop();
}

/**
 * Streaming signal: the product's own stop control (HIGH confidence) or a
 * final-line status word (weaker secondary, last line only).
 */
function isStreaming(): boolean {
  if (resolve(STREAMING_MARKER, document).element) return true;
  const lastLine = transcriptText().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return /^(thinking|working|running|generating|editing|searching)[\s.…]*$/i.test(lastLine);
}

function looksComplete(text: string): boolean {
  return /\b(done|complete[d]?|finished)\b/i.test(text.slice(-200));
}

/**
 * Safe repository/branch/commit/PR/test observations (§17) — extraction
 * only; WorkflowOS/GitHub remain authoritative.
 */
export function extractRepositoryObservations(text: string): {
  branch?: string;
  commitRef?: string;
  pullRequestRef?: string;
  testSummary?: Record<string, unknown>;
} {
  const result: {
    branch?: string;
    commitRef?: string;
    pullRequestRef?: string;
    testSummary?: Record<string, unknown>;
  } = {};
  const branch = text.match(/branch[:\s]+`?(feat\/[A-Za-z0-9._/-]+)`?/i);
  if (branch) result.branch = branch[1];
  const commit = text.match(/commit[:\s]+`?([0-9a-f]{7,40})`?/i);
  if (commit) result.commitRef = commit[1];
  const pr = text.match(/(?:pull request|PR)[:\s]+#?(\d+)/i);
  if (pr) result.pullRequestRef = `github:pr:${pr[1]}`;
  const tests = text.match(/(\d+)\s+tests?\s+passed/i);
  if (tests) result.testSummary = { pass: Number.parseInt(tests[1]!, 10), fail: 0 };
  return result;
}

function transcriptText(): string {
  // Observed product anchor: [data-message-author-role="assistant"] on
  // response messages. Join ALL assistant messages in DOM order so the
  // transcript text reflects the whole conversation (a single-message
  // region would leave stale status lines stuck at the tail).
  // textContent ONLY — provider output is untrusted data (§22).
  const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (messages.length > 0) {
    const parts: string[] = [];
    messages.forEach((m) => parts.push((m.textContent ?? '').trim()));
    return parts.join('\n').replace(/\s+\n/g, '\n').trim();
  }
  const region = resolve(TRANSCRIPT, document);
  return (region.element ?? document.body).textContent?.replace(/\s+\n/g, '\n').trim() ?? '';
}

function visibleErrorText(): string | null {
  for (const strategy of ERROR_SURFACES) {
    for (const el of strategy.find(document)) {
      const text = el.textContent?.trim();
      if (text) return text;
    }
  }
  return null;
}

function hasConfirmationPrompt(): boolean {
  const dialogs = document.querySelectorAll('[role="alertdialog"], [role="dialog"]');
  for (const dialog of dialogs) {
    if (CONFIRMATION_PATTERN.test(dialog.textContent ?? '')) return true;
  }
  return false;
}

function summarize(text: string): string {
  const tail = text.slice(-600).trim();
  return tail.length < text.length ? `…${tail}` : tail;
}

// --- stop (§20) ----------------------------------------------------------------

export async function stop(): Promise<void> {
  if (!state) return;
  state.stopped = true;
  state.observer?.disconnect();
  state.observer = null;
  if (state.quietTimer) clearTimeout(state.quietTimer);
  for (const timer of state.timers) {
    clearTimeout(timer);
    clearInterval(timer as unknown as ReturnType<typeof setInterval>);
  }
  state.timers.clear();
  state = null;
}

/** Test helper: current phase. */
export function currentPhase(): ChatgptPhase | null {
  return state?.phase ?? null;
}

/** Aggregate export consumed by the bridge content script. */
export const chatgptPageRuntime = {
  appliesTo,
  attach,
  stop,
  bindTransport,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * WORK-029: Z.ai page runtime — executes INSIDE the chat.z.ai page
 * (isolated world content script). All Z.ai DOM interaction lives here.
 *
 * Flow (§5–§14, §28):
 *   attach(session) →
 *     1. detect login wall            → BLOCKED "Please sign in to Z.ai"
 *     2. locate composer (confidence) → BLOCKED "Z.ai UI changed…" if none
 *     3. verify sha256(prompt) === promptDigest → BLOCKED if mismatch
 *        (NEVER submit a prompt that fails the identity check)
 *     4. if !promptSubmitted: inject via the native value setter + input
 *        event (React-controlled composer), read back + verify, submit ONCE
 *     5. record the conversation URL (externalSessionRef, safe metadata only)
 *     6. observe the transcript region with a scoped MutationObserver:
 *        progress → completion (multi-signal + debounce), visible errors →
 *        failed, session expiry → blocked
 *   stop() disconnects everything. Reload-safe: on re-attach with
 *   promptSubmitted=true the runtime NEVER re-injects — observe only.
 *
 * SECURITY: extraction is textContent-only (no innerHTML/eval); no cookie
 * access; no credentials; observations never carry WorkflowOS authority
 * outcomes. Conversation scoping (§16): after submit, observations only flow
 * while the URL stays within the recorded conversation path.
 */

import { message } from '../../shared/messages.js';
import type {
  ZaiAttachResult,
  ZaiObservation,
  ZaiPageSession,
  ZaiPhase,
} from './zai-types.js';

export type { ZaiPageSession } from './zai-types.js';
import {
  COMPOSER,
  CONFIRMATION_PATTERN,
  ERROR_SURFACES,
  HARD_FAILURE_PATTERN,
  LOGIN_WALL,
  RATE_LIMIT_PATTERN,
  SESSION_EXPIRY_PATTERN,
  TRANSCRIPT,
  resolve,
} from './zai-selectors.js';

/** Completion stability window: transcript must stay quiet this long. */
const COMPLETION_QUIET_MS = 2500;
/** How long a failed composer/discovery state retries before blocking. */
const DISCOVERY_TIMEOUT_MS = 20000;
const CONVERSATION_POLL_MS = 400;
const CONVERSATION_POLL_MAX = 15000;

interface RuntimeState {
  session: ZaiPageSession;
  phase: ZaiPhase;
  observer: MutationObserver | null;
  timers: Set<ReturnType<typeof setTimeout>>;
  conversationPath: string | null;
  lastTranscriptText: string;
  quietTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  injectedExecutionIds: Set<string>;
}

let state: RuntimeState | null = null;

// --- messaging (to the background via the bridge's runtime port) ----------

type SendMessage = (msg: unknown) => Promise<unknown>;
let send: SendMessage = async (msg) => {
  void msg;
  return null;
};

/** Wire the transport (the content script passes chrome.runtime.sendMessage). */
export function bindTransport(transport: SendMessage): void {
  send = transport;
}

// --- observability (§32: safe telemetry — never prompts/tokens/cookies) ----

async function emitPhase(phase: ZaiPhase, detail?: string): Promise<void> {
  if (state) state.phase = phase;
  await send(message('PROVIDER_STATUS', state?.session.executionId ?? null, { phase, detail }));
}

async function emitObservation(observation: Omit<ZaiObservation, 'executionId'>): Promise<void> {
  if (!state) return;
  if (state.stopped) return;
  const full: ZaiObservation = { ...observation, executionId: state.session.executionId };
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

// --- digest (§8: identity check before submission) --------------------------

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- attach ------------------------------------------------------------------

export function appliesTo(provider: string): boolean {
  return provider === 'zai';
}

export async function attach(session: ZaiPageSession): Promise<ZaiAttachResult> {
  // One automation session per execution; a stale state for a DIFFERENT
  // execution is stopped first (§17 — never observe across executions).
  if (state && state.session.executionId !== session.executionId) {
    await stop();
  }
  if (state && state.session.executionId === session.executionId && !state.stopped) {
    // Already attached — at most refresh the submitted flag.
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

  // 1. Login wall (§5/§22).
  const login = resolve(LOGIN_WALL, document);
  const composerMatch = resolve(COMPOSER, document);
  if (login.element && !composerMatch.element) {
    await emitObservation({
      kind: 'blocked',
      reason: 'Please sign in to Z.ai.',
      output: 'Z.ai session is not authenticated.',
    });
    await emitPhase('blocked', 'login-required');
    await stop();
    return { attached: false, phase: 'blocked', detail: 'login-required' };
  }

  // 2. Composer discovery with bounded retry (SPA may still be mounting).
  const composer = await waitForComposer();
  if (!composer) {
    await emitObservation({
      kind: 'blocked',
      reason: 'Z.ai UI changed; automatic execution paused.',
      output: 'Composer element not found with known selectors.',
    });
    await emitPhase('blocked', 'composer-not-found');
    await stop();
    return { attached: false, phase: 'blocked', detail: 'composer-not-found' };
  }

  // 3. Digest identity check — mismatch means NEVER submit (§8/§35).
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

  // 4. Inject exactly once (§4/§28/§38.4).
  if (!session.promptSubmitted && !state.injectedExecutionIds.has(session.executionId)) {
    const inserted = injectPrompt(composer.element as HTMLTextAreaElement, session.prompt);
    if (!inserted) {
      await emitObservation({
        kind: 'blocked',
        reason: 'Z.ai UI changed; automatic execution paused.',
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
        reason: 'Z.ai send control unavailable.',
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
      output: 'Prompt submitted to Z.ai.',
    });
  } else {
    // Reload/recovery path (§28): task already submitted — observe only.
    await emitPhase('agent-running', 'recovery-observe-only');
  }

  // 5. Record the conversation URL once Z.ai transitions to /chat/<id>.
  void trackConversation();

  // 6. Observe the transcript.
  observeTranscript();

  return { attached: true, phase: state.phase };
}

// --- composer helpers ---------------------------------------------------------

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
 * Insert the EXACT prompt into the React-controlled composer via the native
 * value setter + input event, then read back and compare byte-for-byte.
 * No transformation, no truncation (§8).
 */
export function injectPrompt(composer: HTMLTextAreaElement, prompt: string): boolean {
  composer.focus();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (!setter) return false;
  setter.call(composer, prompt);
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  composer.dispatchEvent(new Event('change', { bubbles: true }));
  // Read-back verification.
  return composer.value === prompt;
}

/** Click the send control (observed: div[aria-label="Send Message"] button). */
export function submit(): boolean {
  // Prefer clicking the inner button when actionable; the observed wrapper
  // div is the tooltip trigger.
  const wrappers = document.querySelectorAll('div[aria-label="Send Message"] button');
  for (const button of wrappers) {
    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.click();
      return true;
    }
  }
  const fallback = resolve(
    [
      { describe: 'button[aria-label*=Send]', find: (d) => [...d.querySelectorAll('button[aria-label*="Send" i]')] },
    ],
    document,
  );
  if (fallback.element) {
    fallback.element.click();
    return true;
  }
  return false;
}

// --- conversation tracking (§7/§16) --------------------------------------------

async function trackConversation(): Promise<void> {
  const deadline = Date.now() + CONVERSATION_POLL_MAX;
  while (Date.now() < deadline && state && !state.stopped) {
    const path = location.pathname;
    if (/^\/chat\//.test(path)) {
      state.conversationPath = path;
      // Safe metadata only — the conversation URL.
      await emitObservation({
        kind: 'progress',
        externalSessionRef: path,
        output: `Z.ai conversation ${path}.`,
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

// --- transcript observation (§11/§12/§13/§14/§19) ------------------------------

function observeTranscript(): void {
  if (!state || state.stopped) return;
  const region = resolve(TRANSCRIPT, document);
  // Observe the chat main area (the transcript's parent) rather than the
  // whole page: sibling surfaces (error banners) mutate inside it, while
  // dialogs portaled to <body> are covered by the light surface interval.
  const target =
    region.element?.parentElement && region.element.parentElement !== document.body
      ? region.element.parentElement
      : (region.element ?? document.body);
  state.observer = new MutationObserver(() => void onTranscriptMutation());
  state.observer.observe(target, { childList: true, subtree: true, characterData: true });
  // §19: LOW-frequency targeted surface check (dialogs portaled to <body> /
  // error banners outside the observed region). Not full-page polling.
  const surfaceInterval = setInterval(() => void onTranscriptMutation(), 1200);
  state.timers.add(surfaceInterval as unknown as ReturnType<typeof setTimeout>);
  // Also surface already-rendered content (recovery after reload).
  void onTranscriptMutation();
}

async function onTranscriptMutation(): Promise<void> {
  if (!state || state.stopped) return;
  if (!inConversationScope()) {
    // User navigated to a different conversation — do NOT observe it (§16).
    return;
  }

  // Visible confirmation prompts block for a human (§24 — stop + ask).
  if (hasConfirmationPrompt()) {
    await emitObservation({
      kind: 'blocked',
      reason: 'Z.ai requires user interaction.',
      output: 'A confirmation prompt is visible; automatic execution paused.',
    });
    await emitPhase('blocked', 'user-interaction-required');
    await stop();
    return;
  }

  // Visible error surfaces (§13/§22/§23).
  const errorText = visibleErrorText();
  if (errorText) {
    if (SESSION_EXPIRY_PATTERN.test(errorText)) {
      await emitObservation({
        kind: 'blocked',
        reason: 'Z.ai session expired; please sign in.',
        output: errorText.slice(0, 300),
      });
    } else if (RATE_LIMIT_PATTERN.test(errorText)) {
      await emitObservation({
        kind: 'failed',
        reason: 'rate-limited',
        output: errorText.slice(0, 300),
      });
    } else if (HARD_FAILURE_PATTERN.test(errorText)) {
      await emitObservation({
        kind: 'failed',
        output: errorText.slice(0, 300),
      });
    }
    if (SESSION_EXPIRY_PATTERN.test(errorText) || HARD_FAILURE_PATTERN.test(errorText)) {
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

  if (isStreaming(text)) {
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
  // Multi-signal completion (§12): transcript quiet for COMPLETION_QUIET_MS
  // AND no streaming marker AND send control actionable again.
  state.quietTimer = setTimeout(() => void checkCompletion(), COMPLETION_QUIET_MS);
  state.timers.add(state.quietTimer);
}

async function checkCompletion(): Promise<void> {
  if (!state || state.stopped) return;
  const text = transcriptText();
  if (isStreaming(text)) {
    scheduleCompletionCheck(); // still working — bounded re-check
    return;
  }
  if (text !== state.lastTranscriptText) {
    state.lastTranscriptText = text;
    await onTranscriptMutation();
    return;
  }
  // §12 multi-signal completion: (1) transcript quiet for the stability
  // window, (2) no streaming marker / status line, (3) text unchanged since
  // the last mutation (double-observation stability). The send control state
  // is intentionally NOT a gate — the real product keeps it disabled while
  // the composer is empty after a submit.
  const observations = extractRepositoryObservations(text);
  await emitObservation({
    kind: 'completed',
    ...observations,
    output: summarize(text),
  });
  await emitPhase('completed');
  await stop();
}

/** Streaming markers observed in the fixture contract (data-state=streaming
 *  plus conventional status text). The real authenticated streaming UI must
 *  be re-verified live (README) — selectors stay in zai-selectors.ts. */
function isStreaming(text: string): boolean {
  // Primary signal: an explicit streaming marker in the transcript DOM.
  if (document.querySelector('[data-state="streaming"], [data-streaming="true"]')) return true;
  // Secondary (weaker) signal: the transcript's FINAL line is an in-progress
  // status line with nothing after it (checked on the last line only, so a
  // historical "Thinking…" message can never keep the run streaming).
  const lastLine = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return /^(thinking|working|running|generating|editing)[\s.…]*$/i.test(lastLine);
}

function looksComplete(text: string): boolean {
  return /\b(done|complete[d]?|finished)\b/i.test(text.slice(-200));
}

/** Safe repository/branch/commit/PR observations (§15) — extraction only. */
export function extractRepositoryObservations(text: string): {
  branch?: string;
  commitRef?: string;
  pullRequestRef?: string;
  testSummary?: Record<string, unknown>;
} {
  const result: { branch?: string; commitRef?: string; pullRequestRef?: string; testSummary?: Record<string, unknown> } = {};
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
  const region = resolve(TRANSCRIPT, document);
  // textContent ONLY — provider output is untrusted data (§20).
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
    const text = dialog.textContent ?? '';
    if (CONFIRMATION_PATTERN.test(text)) return true;
  }
  return false;
}

function summarize(text: string): string {
  // Trailing snippet only — observations stay small; full prompts are never
  // echoed back.
  const tail = text.slice(-600).trim();
  return tail.length < text.length ? `…${tail}` : tail;
}

// --- stop (§25) ----------------------------------------------------------------

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
  const finished = state.phase;
  state = null;
  void finished;
}

/** Test helper: current phase (never used by production flow control). */
export function currentPhase(): ZaiPhase | null {
  return state?.phase ?? null;
}

/** Aggregate export consumed by the bridge content script. */
export const zaiPageRuntime = {
  appliesTo,
  attach,
  stop,
  bindTransport,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

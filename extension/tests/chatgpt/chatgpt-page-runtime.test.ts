/** @vitest-environment jsdom */
/**
 * WORK-030 §28/§33 — ChatGPT page runtime tests against the OBSERVED fixture
 * DOM: detection/injection (contenteditable)/digest/send-once/progress/
 * completion/failure/blocked/session expiry/confirmation/stop/reload-resume/
 * duplicate prevention/XSS safety.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadFixture,
  installFixtureComposer,
  agentMessage,
  showError,
  setStreaming,
  sha256,
} from './helpers.js';
import {
  attach,
  stop,
  bindTransport,
  injectPrompt,
  normalizeEditorText,
  extractRepositoryObservations,
  detectSurface,
  appliesTo,
  type ChatgptPageSession,
} from '../../src/providers/chatgpt/chatgpt-page-runtime.js';

const PROMPT =
  '# Implementation Instructions — WORK-CGPT-001\n\n## Objective\nProve the ChatGPT adapter.';

function makeSession(overrides: Partial<ChatgptPageSession> = {}): ChatgptPageSession {
  return {
    executionId: 'wf_cgpt00001',
    workItemLabel: 'WORK-CGPT-001',
    provider: 'chatgpt',
    repository: 'workflowos/repo',
    branch: 'feat/work-cgpt-001',
    prompt: PROMPT,
    promptDigest: sha256(PROMPT),
    promptSubmitted: false,
    taskKind: 'implementation',
    ...overrides,
  };
}

describe('ChatGPT page runtime (fixture = observed DOM)', () => {
  let sent: Array<{ type: string; executionId: string | null; payload: Record<string, unknown> }>;

  beforeEach(() => {
    sent = [];
    (window as unknown as { __cgptSubmits?: number }).__cgptSubmits = 0;
    bindTransport(async (msg) => {
      sent.push(msg as { type: string; executionId: string | null; payload: Record<string, unknown> });
      return null;
    });
  });

  afterEach(async () => {
    await stop();
  });

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const countSubmits = () => (window as unknown as { __cgptSubmits?: number }).__cgptSubmits ?? 0;

  it('appliesTo(chatgpt) only', () => {
    expect(appliesTo('chatgpt')).toBe(true);
    expect(appliesTo('zai')).toBe(false);
    expect(appliesTo('fake')).toBe(false);
    expect(appliesTo('claude')).toBe(false);
  });

  it('happy path (CODEX surface): digest verified → injected → submitted ONCE → task → completed', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    const result = await attach(makeSession());
    expect(result.attached).toBe(true);

    // The contenteditable composer received the EXACT prompt (normalized
    // read-back verified inside injectPrompt).
    const composer = doc.querySelector('#prompt-textarea') as HTMLElement;
    expect(normalizeEditorText(composer.textContent ?? '')).toBe(normalizeEditorText(PROMPT));
    // Send button was clicked exactly once (real submit counter).
    expect(countSubmits()).toBe(1);

    // Codex task created (/codex/t/<id>) — safe externalSessionRef.
    window.history.pushState({}, '', '/codex/t/cgpt-abc123');
    await wait(600);
    expect(
      sent.some(
        (s) =>
          s.type === 'EXECUTION_PROGRESS' &&
          s.payload.externalSessionRef === '/codex/t/cgpt-abc123',
      ),
    ).toBe(true);

    // Agent lifecycle: streaming (stop-button marker) → done (marker hidden).
    setStreaming(doc, true);
    agentMessage(doc, 'Thinking…', 'streaming');
    await wait(100);
    agentMessage(
      doc,
      'Task complete.\nbranch: feat/work-fixture-001\ncommit: 1a2b3c4d5e6f\npull request: #9\n12 tests passed',
      'done',
    );
    setStreaming(doc, false);
    doc.querySelector('[data-state="streaming"]')?.removeAttribute('data-state');
    await wait(3000);

    const completed = sent.find((s) => s.type === 'EXECUTION_COMPLETED');
    expect(completed).toBeTruthy();
    expect(completed!.payload.branch).toBe('feat/work-fixture-001');
    expect(completed!.payload.commitRef).toBe('1a2b3c4d5e6f');
    expect(completed!.payload.pullRequestRef).toBe('github:pr:9');
    expect(completed!.payload.testSummary).toEqual({ pass: 12, fail: 0 });
    // Exactly one submit for the whole lifecycle.
    expect(countSubmits()).toBe(1);
  });

  it('duplicate prevention: re-attach after reload (promptSubmitted=true) NEVER re-injects', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    await attach(makeSession());
    expect(countSubmits()).toBe(1);

    const composer = doc.querySelector('#prompt-textarea') as HTMLElement;
    composer.textContent = ''; // as after a reload

    await stop();
    await attach(makeSession({ promptSubmitted: true }));
    await wait(200);

    expect(normalizeEditorText(composer.textContent ?? '')).toBe(''); // NOT re-injected
    expect(countSubmits()).toBe(1); // no second submit
  });

  it('digest mismatch → BLOCKED and NO submission (§8/§33)', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    const result = await attach(makeSession({ promptDigest: 'deadbeef'.repeat(8) }));
    expect(result.attached).toBe(false);
    expect(result.detail).toBe('digest-mismatch');
    const blocked = sent.find((s) => s.type === 'EXECUTION_BLOCKED');
    expect(blocked).toBeTruthy();
    expect(blocked!.payload.reason).toMatch(/digest mismatch/i);
    expect((doc.querySelector('#prompt-textarea') as HTMLElement).textContent).toBe('');
    expect(countSubmits()).toBe(0);
  });

  // ------------------------------------------------------------------
  // PR #33 review: SURFACE GATING — implementation requires Codex.
  // ------------------------------------------------------------------

  it('implementation on the CHAT surface → BLOCKED "ChatGPT coding environment unavailable or unverified." + ZERO submits (no silent fallback)', async () => {
    const doc = loadFixture(); // conversational Chat page (composer present)
    installFixtureComposer(doc);
    const result = await attach(makeSession({ taskKind: 'implementation' }));
    expect(result.attached).toBe(false);
    expect(result.detail).toBe('coding-surface-unavailable');
    const blocked = sent.find((s) => s.type === 'EXECUTION_BLOCKED');
    expect(blocked).toBeTruthy();
    expect(blocked!.payload.reason).toBe(
      'ChatGPT coding environment unavailable or unverified.',
    );
    // The Chat composer received NOTHING — no fallback submit.
    expect((doc.querySelector('#prompt-textarea') as HTMLElement).textContent).toBe('');
    expect(countSubmits()).toBe(0);
  });

  it('detectSurface: /codex → coding-agent (HIGH); /c/<uuid> or root → conversational-chat; /work → work; else unknown', () => {
    loadFixture({}, 'codex');
    expect(detectSurface()).toMatchObject({ surface: 'coding-agent', confidence: 'high' });
    loadFixture();
    expect(detectSurface().surface).toBe('conversational-chat');
    window.history.pushState({}, '', '/work');
    expect(detectSurface()).toMatchObject({ surface: 'work' });
    window.history.pushState({}, '', '/gpts/some-other-surface');
    expect(detectSurface().surface).toBe('unknown');
  });

  it('conversational Chat support is KEPT for conversational tasks (no coding gate)', async () => {
    const doc = loadFixture(); // Chat surface
    installFixtureComposer(doc);
    const result = await attach(makeSession({ taskKind: 'conversational' }));
    expect(result.attached).toBe(true);
    expect(countSubmits()).toBe(1);
    expect(
      sent.some((s) => s.type === 'EXECUTION_PROGRESS' && /submitted to ChatGPT/.test(String(s.payload.output))),
    ).toBe(true);
  });

  it('implementation on an UNKNOWN surface → BLOCKED (never guesses, never submits)', async () => {
    loadFixture();
    window.history.pushState({}, '', '/gpts/some-other-surface');
    const result = await attach(makeSession());
    expect(result.attached).toBe(false);
    expect(result.detail).toBe('coding-surface-unavailable');
    expect(countSubmits()).toBe(0);
  });

  it('login wall (buttons) → BLOCKED "Please sign in to ChatGPT." (no submit attempts)', async () => {
    loadFixture({ wall: 'login' });
    const result = await attach(makeSession());
    expect(result.attached).toBe(false);
    const blocked = sent.find((s) => s.type === 'EXECUTION_BLOCKED');
    expect(blocked!.payload.reason).toBe('Please sign in to ChatGPT.');
    expect(countSubmits()).toBe(0);
  });

  it('login wall (auth/login path) → BLOCKED even without login buttons', async () => {
    loadFixture({ wall: 'login' });
    // Simulate the product's redirect without the wall buttons visible.
    (document.querySelector('#login-btn') as HTMLElement | null)?.setAttribute('hidden', '');
    const result = await attach(makeSession());
    expect(result.attached).toBe(false);
    expect(result.detail).toBe('login-required');
  });

  it('visible generation failure → failed + stop (no infinite observation)', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    await attach(makeSession());
    setStreaming(doc, true);
    agentMessage(doc, 'Working…', 'streaming');
    await wait(100);
    showError(doc, 'Generation failed: something went wrong. Please try again.');
    await wait(1600);
    const failed = sent.find((s) => s.type === 'EXECUTION_FAILED');
    expect(failed).toBeTruthy();
    const after = sent.length;
    agentMessage(doc, 'more noise');
    await wait(3000);
    expect(sent.length).toBe(after);
  });

  it('rate-limit error text → failed classification', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    await attach(makeSession());
    showError(doc, "You've hit your usage limit — too many requests.");
    await wait(1600);
    const failed = sent.find((s) => s.type === 'EXECUTION_FAILED');
    expect(failed).toBeTruthy();
  });

  it('session-expiry error text → BLOCKED "ChatGPT session unavailable; please sign in again."', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    await attach(makeSession());
    showError(doc, 'Your session has expired. Please log in to continue.');
    await wait(1600);
    const blocked = sent.find((s) => s.type === 'EXECUTION_BLOCKED');
    expect(blocked!.payload.reason).toBe('ChatGPT session unavailable; please sign in again.');
  });

  it('confirmation prompt → BLOCKED "ChatGPT requires user confirmation." (§16 stop + ask)', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    await attach(makeSession());
    const dlg = doc.createElement('div');
    dlg.setAttribute('role', 'alertdialog');
    const inner = doc.createElement('div');
    inner.textContent = 'Confirm: allow ChatGPT to run this action?';
    dlg.appendChild(inner);
    doc.body.appendChild(dlg);
    await wait(1600);
    const blocked = sent.find((s) => s.type === 'EXECUTION_BLOCKED');
    expect(blocked!.payload.reason).toBe('ChatGPT requires user confirmation.');
  });

  it('cross-conversation scope: observations stop when the user navigates away (§18)', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    await attach(makeSession());
    window.history.pushState({}, '', '/codex/t/cgpt-scope-1');
    await wait(600);
    window.history.pushState({}, '', '/codex/t/OTHER-task');
    agentMessage(doc, 'a different conversation message', 'streaming');
    await wait(3000);
    expect(
      sent.some((s) => s.payload.output && /a different conversation message/.test(String(s.payload.output))),
    ).toBe(false);
  });

  it('stop() disconnects observers — no further observations (§20)', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    await attach(makeSession());
    await stop();
    const after = sent.length;
    agentMessage(doc, 'post-stop noise');
    showError(doc, 'Generation failed after stop');
    await wait(3000);
    expect(sent.length).toBe(after);
  });

  it('provider output is DATA: XSS payloads extracted as text, never executed (§22/§33)', async () => {
    const doc = loadFixture({}, 'codex');
    installFixtureComposer(doc);
    await attach(makeSession());
    agentMessage(
      doc,
      'Task complete.\n<img src=x onerror="window.__pwned=1"><script>window.__pwned2=1<' + '/script>',
      'done',
    );
    doc.querySelector('[data-state="streaming"]')?.removeAttribute('data-state');
    await wait(4500); // surface interval (1.2s) + quiet window (2.5s) margin
    const completed = sent.find((s) => s.type === 'EXECUTION_COMPLETED');
    expect(completed).toBeTruthy();
    expect(String(completed!.payload.output)).toContain('<img src=x onerror');
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__pwned2).toBeUndefined();
  });

  it('injectPrompt verifies read-back (contenteditable) — tampered content fails', async () => {
    const doc = loadFixture();
    const composer = doc.querySelector('#prompt-textarea') as HTMLElement;
    // Sabotage the editor: textContent ignores writes (read-only override).
    Object.defineProperty(composer, 'textContent', {
      get: () => 'tampered',
      set: () => undefined,
      configurable: true,
    });
    expect(injectPrompt(composer, 'hello')).toBe(false);
  });

  it('injectPrompt handles the textarea composer form (historical fallback)', () => {
    const doc = loadFixture();
    // Swap in the historical textarea composer.
    const editor = doc.querySelector('#prompt-textarea') as HTMLElement;
    const textarea = doc.createElement('textarea');
    textarea.id = 'prompt-textarea';
    editor.replaceWith(textarea);
    expect(injectPrompt(textarea, 'exact prompt text')).toBe(true);
    expect(textarea.value).toBe('exact prompt text');
  });

  it('normalizeEditorText handles nbsp/zero-width/CR representations', () => {
    expect(normalizeEditorText('a\u00a0b\u200b')).toBe('a b');
    expect(normalizeEditorText('x\r\ny')).toBe('x\ny');
    expect(normalizeEditorText('  padded  ')).toBe('padded');
  });

  it('extractRepositoryObservations parses branch/commit/PR/tests safely', () => {
    const parsed = extractRepositoryObservations(
      'done. branch: `feat/work-x-1` commit: abc12345 pull request: #12 — 8 tests passed',
    );
    expect(parsed.branch).toBe('feat/work-x-1');
    expect(parsed.commitRef).toBe('abc12345');
    expect(parsed.pullRequestRef).toBe('github:pr:12');
    expect(parsed.testSummary).toEqual({ pass: 8, fail: 0 });
    expect(extractRepositoryObservations('nothing here')).toEqual({});
  });

  it('cross-execution attach: a new executionId stops the previous runtime (§18)', async () => {
    loadFixture();
    installFixtureComposer(document);
    await attach(makeSession({ executionId: 'wf_a' }));
    await attach(makeSession({ executionId: 'wf_b' }));
    expect(
      sent.filter((s) => s.executionId === 'wf_a' && s.type === 'EXECUTION_COMPLETED').length,
    ).toBe(0);
  });
});

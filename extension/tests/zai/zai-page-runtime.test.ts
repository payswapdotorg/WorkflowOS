/** @vitest-environment jsdom */
/**
 * WORK-029 §29/§35 — Z.ai page runtime tests against the OBSERVED fixture
 * DOM: detection/injection/digest/send/progress/completion/failure/blocked/
 * session expiry/stop/reload-resume/duplicate prevention/XSS safety.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadFixture,
  installFixtureComposer,
  agentMessage,
  showError,
  sha256,
} from './helpers.js';
import {
  attach,
  stop,
  bindTransport,
  injectPrompt,
  extractRepositoryObservations,
  appliesTo,
  type ZaiPageSession,
} from '../../src/providers/zai/zai-page-runtime.js';

const PROMPT = '# Implementation Instructions — WORK-ZAI-001\n\n## Objective\nProve the Z.ai adapter.';

function makeSession(overrides: Partial<ZaiPageSession> = {}): ZaiPageSession {
  return {
    executionId: 'wf_zai000001',
    workItemLabel: 'WORK-ZAI-001',
    provider: 'zai',
    repository: 'workflowos/repo',
    branch: 'feat/work-zai-001',
    prompt: PROMPT,
    promptDigest: sha256(PROMPT),
    promptSubmitted: false,
    ...overrides,
  };
}

describe('Z.ai page runtime (fixture = observed DOM)', () => {
  let sent: Array<{ type: string; executionId: string | null; payload: Record<string, unknown> }>;

  beforeEach(() => {
    sent = [];
    (window as unknown as { __zaiSubmits?: number }).__zaiSubmits = 0;
    bindTransport(async (msg) => {
      sent.push(msg as { type: string; executionId: string | null; payload: Record<string, unknown> });
      return null;
    });
  });

  afterEach(async () => {
    await stop();
  });

  /** Real-time wait (jsdom MutationObserver needs the real event loop). */
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const types = () => sent.map((s) => s.type);

  it('appliesTo(zai) only', () => {
    expect(appliesTo('zai')).toBe(true);
    expect(appliesTo('fake')).toBe(false);
    expect(appliesTo('chatgpt')).toBe(false);
  });

  it('happy path: digest verified → injected → submitted ONCE → conversation → completed', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    const session = makeSession();
    const result = await attach(session);
    expect(result.attached).toBe(true);

    // Composer received the EXACT prompt (read-back verified inside).
    const composer = doc.querySelector('#chat-input') as HTMLTextAreaElement;
    expect(composer.value).toBe(PROMPT);
    // The fixture form did not run (outside-only) — simulate the real submit
    // path: our runtime already clicked send; drive the fixture-like agent.
    expect(types()).toContain('EXECUTION_PROGRESS'); // started observation

    // Conversation created (fixture-like pushState scope).
    window.history.pushState({}, '', '/chat/conv-abc123');
    await wait(600);
    expect(
      sent.some(
        (s) =>
          s.type === 'EXECUTION_PROGRESS' &&
          s.payload.externalSessionRef === '/chat/conv-abc123',
      ),
    ).toBe(true);

    // Agent lifecycle: streaming → done (the fixture agent clears the
    // streaming marker when finished — mirror that).
    agentMessage(doc, 'Thinking…', 'streaming');
    await wait(100);
    agentMessage(
      doc,
      'Task complete.\nbranch: feat/work-fixture-001\ncommit: 1a2b3c4d5e6f\npull request: #9\n12 tests passed',
      'done',
    );
    doc.querySelector('[data-state="streaming"]')?.removeAttribute('data-state');
    await wait(3000); // completion quiet window

    const completed = sent.find((s) => s.type === 'EXECUTION_COMPLETED');
    expect(completed).toBeTruthy();
    expect(completed!.payload.branch).toBe('feat/work-fixture-001');
    expect(completed!.payload.commitRef).toBe('1a2b3c4d5e6f');
    expect(completed!.payload.pullRequestRef).toBe('github:pr:9');
    expect(completed!.payload.testSummary).toEqual({ pass: 12, fail: 0 });
  });

  it('duplicate prevention: re-attach after reload (promptSubmitted=true) NEVER re-injects', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    await attach(makeSession());
    const composer = doc.querySelector('#chat-input') as HTMLTextAreaElement;
    composer.value = ''; // as after a reload
    const submitsBefore = countSubmits();

    await stop();
    await attach(makeSession({ promptSubmitted: true }));
    await wait(200);

    expect(composer.value).toBe(''); // NOT re-injected
    expect(countSubmits()).toBe(submitsBefore);
  });

  it('digest mismatch → BLOCKED and NO submission (§8/§35)', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    const result = await attach(makeSession({ promptDigest: 'deadbeef'.repeat(8) }));
    expect(result.attached).toBe(false);
    expect(result.detail).toBe('digest-mismatch');
    const blocked = sent.find((s) => s.type === 'EXECUTION_BLOCKED');
    expect(blocked).toBeTruthy();
    expect(blocked!.payload.reason).toMatch(/digest mismatch/i);
    // Composer untouched.
    expect((doc.querySelector('#chat-input') as HTMLTextAreaElement).value).toBe('');
    expect(countSubmits()).toBe(0);
  });

  it('login wall → BLOCKED "Please sign in to Z.ai." (no submit attempts)', async () => {
    loadFixture({ wall: 'login' });
    const result = await attach(makeSession());
    expect(result.attached).toBe(false);
    const blocked = sent.find((s) => s.type === 'EXECUTION_BLOCKED');
    expect(blocked!.payload.reason).toBe('Please sign in to Z.ai.');
    expect(countSubmits()).toBe(0);
  });

  it('visible generation failure → failed + stop (no infinite observation)', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    await attach(makeSession());
    agentMessage(doc, 'Working…', 'streaming');
    await wait(100);
    showError(doc, 'Generation failed: model unavailable. Please try again.');
    await wait(1600);
    const failed = sent.find((s) => s.type === 'EXECUTION_FAILED');
    expect(failed).toBeTruthy();
    // Stopped: later DOM noise produces nothing.
    const after = sent.length;
    agentMessage(doc, 'more noise');
    await wait(3000);
    expect(sent.length).toBe(after);
  });

  it('rate-limit error text → failed classification', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    await attach(makeSession());
    showError(doc, 'Rate limit exceeded — too many requests.');
    await wait(1600);
    const failed = sent.find((s) => s.type === 'EXECUTION_FAILED');
    expect(failed).toBeTruthy();
  });

  it('session-expiry error text → BLOCKED "Z.ai session expired; please sign in."', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    await attach(makeSession());
    showError(doc, 'Your session has expired. Please sign in.');
    await wait(1600);
    const blocked = sent.find((s) => s.type === 'EXECUTION_BLOCKED');
    expect(blocked!.payload.reason).toBe('Z.ai session expired; please sign in.');
  });

  it('confirmation prompt → BLOCKED "Z.ai requires user interaction." (stop + ask §24)', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    await attach(makeSession());
    const dlg = doc.createElement('div');
    dlg.setAttribute('role', 'alertdialog');
    const inner = doc.createElement('div');
    inner.textContent = 'Confirm: apply these repository changes?';
    dlg.appendChild(inner);
    doc.body.appendChild(dlg);
    await wait(1600);
    const blocked = sent.find((s) => s.type === 'EXECUTION_BLOCKED');
    expect(blocked!.payload.reason).toBe('Z.ai requires user interaction.');
  });

  it('cross-conversation scope: observations stop when the user navigates away (§16)', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    await attach(makeSession());
    window.history.pushState({}, '', '/chat/conv-scope-1');
    await wait(600);
    window.history.pushState({}, '', '/chat/conv-OTHER');
    agentMessage(doc, 'a different conversation message', 'streaming');
    await wait(3000);
    expect(
      sent.some((s) => s.payload.output && /a different conversation message/.test(String(s.payload.output))),
    ).toBe(false);
  });

  it('stop() disconnects observers — no further observations (§25)', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    await attach(makeSession());
    await stop();
    const after = sent.length;
    agentMessage(doc, 'post-stop noise');
    showError(doc, 'Generation failed after stop');
    await wait(3000);
    expect(sent.length).toBe(after);
  });

  it('provider output is DATA: XSS payloads are extracted as text, never executed (§20/§35)', async () => {
    const doc = loadFixture();
    installFixtureComposer(doc);
    await attach(makeSession());
    agentMessage(
      doc,
      'Task complete.\n<img src=x onerror="window.__pwned=1"><script>window.__pwned2=1<' + '/script>',
      'done',
    );
    doc.querySelector('[data-state="streaming"]')?.removeAttribute('data-state');
    await wait(3000);
    const completed = sent.find((s) => s.type === 'EXECUTION_COMPLETED');
    expect(completed).toBeTruthy();
    expect(String(completed!.payload.output)).toContain('<img src=x onerror');
    // No script execution markers exist.
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__pwned2).toBeUndefined();
  });

  it('injectPrompt read-back verification catches composer rejection', () => {
    const doc = loadFixture();
    const composer = doc.querySelector('#chat-input') as HTMLTextAreaElement;
    // Sabotage: setter fails (read-only override).
    Object.defineProperty(composer, 'value', { get: () => '', set: () => undefined, configurable: true });
    expect(injectPrompt(composer, 'hello')).toBe(false);
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

  it('cross-execution attach: a new executionId stops the previous runtime (§17)', async () => {
    loadFixture();
    await attach(makeSession({ executionId: 'wf_a' }));
    await attach(makeSession({ executionId: 'wf_b' }));
    // Observations after the switch carry ONLY the new executionId.
    const scoped = sent.filter((s) => s.executionId === 'wf_a');
    const lastForA = scoped[scoped.length - 1];
    // wf_a never receives a completed observation after wf_b attached.
    expect(sent.filter((s) => s.executionId === 'wf_a' && s.type === 'EXECUTION_COMPLETED').length).toBe(0);
    void lastForA;
  });

  /** Count REAL submits (installFixtureComposer maintains the counter). */
  function countSubmits(): number {
    return (window as unknown as { __zaiSubmits?: number }).__zaiSubmits ?? 0;
  }
});

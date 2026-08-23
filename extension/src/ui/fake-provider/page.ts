/**
 * WorkflowOS Companion — fake provider page (deterministic test mode).
 *
 * An EXTENSION page that simulates an external AI platform. It receives the
 * session (prompt, repository, branch) from the background via GET_SESSION —
 * the page never sees the callback token. It drives a deterministic
 * lifecycle (started → progress → completed) by posting execution
 * observation messages, which the background routes through the fake
 * adapter into the reporter. All rendering uses textContent (§22: provider
 * output is data).
 */
import { message } from '../../shared/messages.js';

interface SessionView {
  executionId: string;
  provider: string;
  workItemLabel: string;
  repository: string | null;
  branch: string;
  status: string;
  prompt: string;
}

const params = new URLSearchParams(window.location.search);
const requestedExecutionId = params.get('executionId') ?? null;
const auto = params.get('auto') === '1';

let session: SessionView | null = null;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function setStatus(status: string): void {
  el('status').textContent = status;
}

function addObservation(text: string): void {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  el('observations').append(li);
}

async function loadSession(): Promise<SessionView | null> {
  const view = (await chrome.runtime.sendMessage(
    message('GET_SESSION', requestedExecutionId, {}),
  )) as SessionView | null;
  if (!view) return null;
  session = view;
  el('execution-id').textContent = view.executionId;
  el('work-item').textContent = view.workItemLabel;
  el('repository').textContent = view.repository ?? '(not linked)';
  el('branch').textContent = view.branch;
  el('prompt').textContent = view.prompt;
  return view;
}

function report(
  type: 'EXECUTION_PROGRESS' | 'EXECUTION_COMPLETED' | 'EXECUTION_FAILED',
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (!session) return Promise.resolve(null);
  return chrome.runtime.sendMessage(message(type, session.executionId, payload));
}

/** Deterministic lifecycle: started → progress ×2 → completed. */
async function runLifecycle(): Promise<void> {
  if (!session) return;
  setStatus('running');
  addObservation('started: fake agent session');

  await report('EXECUTION_PROGRESS', {
    externalSessionRef: `fake-session-${session.executionId}`,
    output: 'Implementation underway — deterministic fake agent.',
  });
  addObservation('progress: implementation underway');
  setStatus('running');

  await report('EXECUTION_PROGRESS', {
    output: 'Tests + typecheck reported passing by the fake agent.',
    testSummary: { pass: 12, fail: 0, skip: 1 },
  });
  addObservation('progress: tests reported passing');

  await report('EXECUTION_COMPLETED', {
    commitRef: `fakesha${session.executionId.slice(-8).padEnd(8, '0')}`,
    branch: session.branch,
    pullRequestRef: null,
    testSummary: { pass: 12, fail: 0, skip: 1 },
    output: 'Fake provider completed the Work Order deterministically.',
  });
  addObservation('completed: fake commit + PR reference reported');
  setStatus('completed');
}

async function failLifecycle(): Promise<void> {
  if (!session) return;
  await report('EXECUTION_FAILED', {
    output: 'Fake provider failure (manual trigger).',
  });
  addObservation('failed: manual failure trigger');
  setStatus('failed');
}

el('run').addEventListener('click', () => void runLifecycle());
el('fail').addEventListener('click', () => void failLifecycle());

void (async () => {
  const view = await loadSession();
  if (!view) {
    setStatus('no session');
    addObservation('No active session — open an execution via WorkflowOS.');
    return;
  }
  setStatus(view.status);
  if (auto) {
    setTimeout(() => void runLifecycle(), 300);
  }
})();

/**
 * WORK-030: ChatGPT bridge content script.
 *
 * Runs on ChatGPT pages (https://*.chatgpt.com/*) + the documented local
 * test fixture origin (http://127.0.0.1:3778). Deliberately THIN and
 * selector-free — all ChatGPT DOM knowledge lives in providers/chatgpt/.
 * Responsibilities mirror the WORK-029 bridge: generic detection
 * announcement, session fetch (token-free view) + page-runtime attach,
 * START/STOP command relay, BRIDGE_READY announcement. It contains NO
 * ChatGPT selectors, NO DOM queries, and NO credentials.
 */
import { detectProvider } from '../providers/detector.js';
import { chatgptPageRuntime, bindTransport } from '../providers/chatgpt/chatgpt-page-runtime.js';
import { message } from '../shared/messages.js';
import type { SessionView } from '../shared/session.js';

bindTransport((msg) => chrome.runtime.sendMessage(msg));

const detection = detectProvider(new URL(window.location.href));
void chrome.runtime
  .sendMessage(
    message('PROVIDER_DETECTED', null, {
      providerId: detection.providerId,
      supported: detection.supported,
      adapterAvailable: detection.adapterAvailable,
      url: window.location.origin,
    }),
  )
  .catch(() => undefined);

async function attachIfApplicable(): Promise<void> {
  const state = (await chrome.runtime.sendMessage(message('GET_STATE', null, {})).catch(
    () => null,
  )) as { session: SessionView | null } | null;
  const session = state?.session ?? null;
  if (!session) return;
  if (!chatgptPageRuntime.appliesTo(session.provider)) return;
  // Token-free payload — no callback credential ever enters the page.
  await chatgptPageRuntime.attach({
    executionId: session.executionId,
    workItemLabel: session.workItemLabel,
    provider: session.provider,
    repository: session.repository,
    branch: session.branch,
    prompt: session.prompt,
    promptDigest: session.promptDigest,
    promptSubmitted: session.promptSubmitted,
    // WorkflowOS external executions are implementation Work Orders — they
    // require the coding-agent surface (Codex). PR #33 review.
    taskKind: 'implementation',
  });
  void chrome.runtime
    .sendMessage(
      message('BRIDGE_READY', session.executionId, {
        providerId: session.provider,
      }),
    )
    .catch(() => undefined);
}

void attachIfApplicable();

chrome.runtime.onMessage.addListener((msg: unknown) => {
  const envelope = msg as { type?: string; executionId?: string | null; timestamp?: unknown };
  if (envelope?.type === 'START_EXECUTION' && typeof envelope.timestamp === 'number') {
    void attachIfApplicable();
  }
  if (envelope?.type === 'STOP_EXECUTION' && typeof envelope.timestamp === 'number') {
    void chatgptPageRuntime.stop();
  }
  return false;
});

// SPA navigation (conversation changes) — re-evaluate attachment so the
// runtime can re-scope its observer (it refuses cross-conversation noise).
let lastPath = window.location.pathname;
window.setInterval(() => {
  if (window.location.pathname !== lastPath) {
    lastPath = window.location.pathname;
    void attachIfApplicable();
  }
}, 800);

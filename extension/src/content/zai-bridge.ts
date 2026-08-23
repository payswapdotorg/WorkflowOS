/**
 * WORK-029: Z.ai bridge content script.
 *
 * Runs on Z.ai pages (https://*.z.ai/*) + the documented local test fixture
 * origin (http://127.0.0.1:3777). Deliberately THIN and selector-free — all
 * Z.ai DOM knowledge lives in providers/zai/. Responsibilities:
 *
 *   - generic provider detection announcement (PROVIDER_DETECTED)
 *   - fetch the current Companion session (token-free view) and, when the
 *     Z.ai page runtime applies, attach it (inject-once OR observe-only
 *     recovery) — the runtime owns every DOM decision
 *   - relay background START_EXECUTION commands to the runtime
 *   - announce BRIDGE_READY so the popup/background know the adapter is live
 *
 * It contains NO Z.ai selectors, NO DOM queries, and NO credentials.
 */
import { detectProvider } from '../providers/detector.js';
import { zaiPageRuntime, bindTransport } from '../providers/zai/zai-page-runtime.js';
import { message } from '../shared/messages.js';
import type { SessionView } from '../shared/session.js';

// Wire the runtime's transport to the extension message bus.
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

/** Fetch the current session view and attach the page runtime when it applies. */
async function attachIfApplicable(): Promise<void> {
  const state = (await chrome.runtime.sendMessage(message('GET_STATE', null, {})).catch(
    () => null,
  )) as { session: SessionView | null } | null;
  const session = state?.session ?? null;
  if (!session) return;
  if (!zaiPageRuntime.appliesTo(session.provider)) return;
  // The runtime receives a TOKEN-FREE payload (no callback credential ever
  // enters the page context).
  await zaiPageRuntime.attach({
    executionId: session.executionId,
    workItemLabel: session.workItemLabel,
    provider: session.provider,
    repository: session.repository,
    branch: session.branch,
    prompt: session.prompt,
    promptDigest: session.promptDigest,
    promptSubmitted: session.promptSubmitted,
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

// Background START_EXECUTION (adapter inject command) → ensure attachment.
chrome.runtime.onMessage.addListener((msg: unknown) => {
  const envelope = msg as { type?: string; executionId?: string | null; timestamp?: unknown };
  if (envelope?.type === 'START_EXECUTION' && typeof envelope.timestamp === 'number') {
    void attachIfApplicable();
  }
  if (envelope?.type === 'STOP_EXECUTION' && typeof envelope.timestamp === 'number') {
    void zaiPageRuntime.stop();
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

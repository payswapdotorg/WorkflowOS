/**
 * WorkflowOS Companion — deterministic FAKE provider adapter (test mode).
 *
 * The fake provider is an EXTENSION PAGE (ui/fake-provider/index.html), not
 * a scraped external site: the adapter contains ZERO DOM selectors. The
 * page drives a deterministic execution lifecycle (started → progress →
 * completed) by posting extension messages, which the background routes
 * into this adapter's observation sink. CI and the WORK-028 browser E2E use
 * it to prove the full WorkflowOS ↔ extension ↔ event-reporting loop without
 * any real AI platform.
 */
import type {
  ExternalProviderAdapter,
  ObservationSink,
  ProviderObservation,
} from '../types.js';

/** Observations routed to this adapter, keyed by executionId. */
const observations = new Map<string, ProviderObservation[]>();
const sinks = new Map<string, ObservationSink>();

/** Test helper: clear module-level buffers/sinks between tests. */
export function resetFakeAdapterState(): void {
  observations.clear();
  sinks.clear();
}

export function pushFakeObservation(executionId: string, observation: ProviderObservation): void {
  const list = observations.get(executionId) ?? [];
  list.push(observation);
  observations.set(executionId, list);
  sinks.get(executionId)?.(observation);
}

export const fakeProviderAdapter: ExternalProviderAdapter = {
  providerId: 'fake',
  displayName: 'Fake (test)',
  capabilities: { openTask: true, injectPrompt: true, observe: true },

  matchesPage(url: URL): boolean {
    return url.protocol === 'chrome-extension:' && url.pathname === '/ui/fake-provider/index.html';
  },

  async openTask(session, runtime) {
    const url = runtime.extensionPageUrl('/ui/fake-provider/index.html', {
      executionId: session.executionId,
      auto: '1',
    });
    const tabId = await runtime.openTab(url);
    return tabId;
  },

  async injectPrompt(session, runtime) {
    // The fake page fetches the session (incl. prompt) from the background
    // via GET_SESSION — nothing to inject (no DOM automation by design).
    void runtime;
    void session;
  },

  async observeExecution(session, _runtime, sink) {
    sinks.set(session.executionId, sink);
    // Replay anything already buffered for this execution.
    for (const observation of observations.get(session.executionId) ?? []) {
      sink(observation);
    }
  },

  detectCompletion(observation) {
    return observation.kind === 'completed';
  },

  detectFailure(observation) {
    return observation.kind === 'failed';
  },

  async collectObservations(session) {
    return observations.get(session.executionId) ?? [];
  },

  async stop(session) {
    sinks.delete(session.executionId);
    observations.delete(session.executionId);
  },
};

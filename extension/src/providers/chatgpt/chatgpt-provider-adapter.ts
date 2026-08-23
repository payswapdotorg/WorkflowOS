/**
 * WORK-030: ChatGPT provider adapter (background side).
 *
 * Orchestrates the REAL ChatGPT web product (https://chatgpt.com) using the
 * user's EXISTING authenticated browser session (no cookies/tokens touched):
 *
 *   openTask      → opens https://chatgpt.com/ (the ROOT is the deterministic
 *                   fresh-composer surface — never an existing /c/… chat)
 *   injectPrompt  → commands the page bridge (START_EXECUTION tab message);
 *                   the bridge runtime verifies the digest and submits
 *                   EXACTLY ONCE, or re-attaches observe-only after reload
 *   observeExec.  → wires the observation sink; page EXECUTION_* messages
 *                   flow through the existing background → reporter path
 *   stop          → tells the page runtime to disconnect observers
 *
 * DOM knowledge lives ONLY in chatgpt-selectors.ts / chatgpt-page-runtime.ts.
 * This file contains NO DOM APIs and NO WorkflowOS HTTP calls — reporting
 * always goes through the sink (the existing ExecutionReporter wiring).
 */
import type {
  AdapterRuntime,
  AdapterSession,
  ExternalProviderAdapter,
  ObservationSink,
  ProviderObservation,
  ProviderSurfaceCapabilities,
} from '../types.js';
import type { ChatgptAdapterConfig } from './chatgpt-types.js';

export interface ChatgptTabPort {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const FIXTURE_STORAGE_KEY = 'wfos.chatgpt.fixtureOrigin';

function createTabPort(): ChatgptTabPort {
  return {
    async sendMessage(tabId: number, msg: unknown) {
      return globalThis.chrome?.tabs?.sendMessage?.(tabId, msg) ?? null;
    },
  };
}

async function readFixtureOrigin(): Promise<string | undefined> {
  const area = globalThis.chrome?.storage?.session;
  if (!area?.get) return undefined;
  const raw = (await area.get([FIXTURE_STORAGE_KEY]))[FIXTURE_STORAGE_KEY];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export async function resolveChatgptConfig(): Promise<ChatgptAdapterConfig> {
  return { chatgptOrigin: CHATGPT_ORIGIN, fixtureOrigin: await readFixtureOrigin() };
}

export class ChatgptProviderAdapter implements ExternalProviderAdapter {
  readonly providerId = 'chatgpt';
  readonly displayName = 'ChatGPT';
  readonly capabilities = { openTask: true, injectPrompt: true, observe: true };

  private readonly sinkBuffer: ProviderObservation[] = [];
  private sinks = new Map<string, ObservationSink>();

  constructor(
    private readonly tabPort: ChatgptTabPort = createTabPort(),
    private configPromise: Promise<ChatgptAdapterConfig> | null = null,
  ) {}

  private async config(): Promise<ChatgptAdapterConfig> {
    this.configPromise ??= resolveChatgptConfig();
    return this.configPromise;
  }

  matchesPage(url: URL): boolean {
    // Production domains: chatgpt.com apex + subdomains (the legacy
    // chat.openai.com host redirects to chatgpt.com; not matched directly).
    if (url.protocol === 'https:' && /(^|\.)chatgpt\.com$/.test(url.hostname)) return true;
    return false;
  }

  /** Fixture matching is config-driven (never enabled in production). */
  async matchesFixture(url: URL): Promise<boolean> {
    const { fixtureOrigin } = await this.config();
    if (!fixtureOrigin) return false;
    try {
      const fixture = new URL(fixtureOrigin);
      return url.origin === fixture.origin;
    } catch {
      return false;
    }
  }

  async openTask(session: AdapterSession, runtime: AdapterRuntime): Promise<number | null> {
    const { chatgptOrigin, fixtureOrigin } = await this.config();
    // PR #33 review: implementation Work Orders target the CODING surface —
    // the Codex web app at chatgpt.com/codex (OpenAI's official product
    // URL). The page runtime verifies the surface before submitting and
    // BLOCKS when it cannot confidently identify Codex (never silently
    // falling back to conversational Chat). The staged fixture origin may
    // carry its own path (e.g. http://127.0.0.1:3778/codex/).
    const target = fixtureOrigin ?? `${chatgptOrigin}/codex`;
    void session;
    return runtime.openTab(target);
  }

  /**
   * PR #33 review surface capabilities. Catalog-consistent: the coding
   * agent (Codex) is 'unverified' until a live signed-in verification pass
   * — the runtime detects the actual page surface and blocks otherwise, so
   * fixture-only proof never reports 'ready' here.
   */
  describeSurfaces(): ProviderSurfaceCapabilities {
    return {
      conversationalChat: 'ready',
      codingAgent: 'unverified',
      implementationSurface: 'coding-agent',
    };
  }

  /**
   * Command the page bridge to run the inject-or-recover flow. Duplicate
   * prevention is layered: the background refuses when promptSubmitted is
   * already true; the page runtime additionally refuses via its in-page
   * per-execution guard (reload-safe, §11/§19).
   */
  async injectPrompt(
    session: AdapterSession & { promptSubmitted?: boolean },
    runtime: AdapterRuntime,
  ): Promise<void> {
    if (session.promptSubmitted) return; // already submitted — never again
    const tabId = await runtime.getActiveTabId();
    if (tabId === null) return;
    await this.tabPort.sendMessage(tabId, {
      type: 'START_EXECUTION',
      executionId: session.executionId,
      timestamp: Date.now(),
      payload: { auto: true },
    });
  }

  async observeExecution(
    session: AdapterSession,
    _runtime: AdapterRuntime,
    sink: ObservationSink,
  ): Promise<void> {
    this.sinks.set(session.executionId, sink);
    for (const observation of [...this.sinkBuffer]) {
      sink(observation);
    }
  }

  detectCompletion(observation: ProviderObservation): boolean {
    return observation.kind === 'completed';
  }

  detectFailure(observation: ProviderObservation): boolean {
    return observation.kind === 'failed';
  }

  async collectObservations(): Promise<ProviderObservation[]> {
    return [...this.sinkBuffer];
  }

  pushObservation(executionId: string, observation: ProviderObservation): void {
    this.sinkBuffer.push(observation);
    this.sinks.get(executionId)?.(observation);
  }

  async stop(session: AdapterSession, runtime: AdapterRuntime): Promise<void> {
    this.sinks.delete(session.executionId);
    const tabId = await runtime.getActiveTabId();
    if (tabId !== null) {
      await this.tabPort
        .sendMessage(tabId, {
          type: 'STOP_EXECUTION',
          executionId: session.executionId,
          timestamp: Date.now(),
          payload: {},
        })
        .catch(() => undefined);
    }
  }
}

export const chatgptProviderAdapter = new ChatgptProviderAdapter();

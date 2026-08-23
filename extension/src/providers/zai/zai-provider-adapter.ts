/**
 * WORK-029: Z.ai provider adapter (background side).
 *
 * Orchestrates the REAL Z.ai web product using the user's EXISTING
 * authenticated browser session (no cookies/tokens are ever touched):
 *
 *   openTask      → opens https://chat.z.ai/ (deterministic new-task path;
 *                   the observed "New Chat" control exists for manual use)
 *   injectPrompt  → commands the page bridge (START_EXECUTION tab message);
 *                   the bridge runtime verifies the prompt digest and
 *                   submits EXACTLY ONCE, or re-attaches observe-only after
 *                   a reload (§28 recovery)
 *   observeExec.  → wires the observation sink; page EXECUTION_* messages
 *                   flow through the existing background → reporter path
 *   stop          → tells the page runtime to disconnect observers
 *
 * DOM knowledge lives ONLY in zai-selectors.ts / zai-page-runtime.ts. This
 * file contains NO DOM APIs and NO WorkflowOS HTTP calls — reporting always
 * goes through the sink (the existing ExecutionReporter wiring).
 */
import type {
  AdapterRuntime,
  AdapterSession,
  ExternalProviderAdapter,
  ObservationSink,
  ProviderObservation,
} from '../types.js';
import type { ZaiAdapterConfig } from './zai-types.js';

/** Tab-messaging port (chrome.tabs.sendMessage in production; mock in tests). */
export interface ZaiTabPort {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

const ZAI_ORIGIN = 'https://chat.z.ai';
const FIXTURE_STORAGE_KEY = 'wfos.zai.fixtureOrigin';

function createTabPort(): ZaiTabPort {
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

/** Adapter config resolution (fixture origin only when explicitly staged). */
export async function resolveZaiConfig(): Promise<ZaiAdapterConfig> {
  return { zaiOrigin: ZAI_ORIGIN, fixtureOrigin: await readFixtureOrigin() };
}

export class ZaiProviderAdapter implements ExternalProviderAdapter {
  readonly providerId = 'zai';
  readonly displayName = 'Z.ai';
  readonly capabilities = { openTask: true, injectPrompt: true, observe: true };

  private readonly sinkBuffer: ProviderObservation[] = [];
  private sinks = new Map<string, ObservationSink>();

  constructor(
    private readonly tabPort: ZaiTabPort = createTabPort(),
    private configPromise: Promise<ZaiAdapterConfig> | null = null,
  ) {}

  private async config(): Promise<ZaiAdapterConfig> {
    this.configPromise ??= resolveZaiConfig();
    return this.configPromise;
  }

  matchesPage(url: URL): boolean {
    // Real Z.ai: apex + subdomains (chat.z.ai is the chat application).
    if (url.protocol === 'https:' && /(^|\.)z\.ai$/.test(url.hostname)) return true;
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
    const { zaiOrigin, fixtureOrigin } = await this.config();
    // Deterministic new-task path: the Z.ai root starts a fresh composer
    // (observed 2026-08-24). We never inject into an existing conversation.
    const target = fixtureOrigin ?? `${zaiOrigin}/`;
    void session;
    return runtime.openTab(target);
  }

  /**
   * Command the page bridge to run the inject-or-recover flow. Duplicate
   * prevention is layered: the background refuses when promptSubmitted is
   * already true; the page runtime additionally refuses when its in-page
   * guard for the executionId is set (reload-safe, §28/§35).
   */
  async injectPrompt(
    session: AdapterSession & { promptSubmitted?: boolean },
    runtime: AdapterRuntime,
  ): Promise<void> {
    if (session.promptSubmitted) return; // already submitted — never again
    const tabId = await runtime.getActiveTabId();
    if (tabId === null) return;
    // The bridge fetches state itself; the command is only a trigger so no
    // prompt material crosses this boundary twice.
    await this.tabPort.sendMessage(tabId, { type: 'START_EXECUTION', executionId: session.executionId, timestamp: Date.now(), payload: { auto: true } });
  }

  async observeExecution(
    session: AdapterSession,
    _runtime: AdapterRuntime,
    sink: ObservationSink,
  ): Promise<void> {
    this.sinks.set(session.executionId, sink);
    // Replay anything already buffered for this execution.
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

  /** Called by tests / future routing to push observations. */
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

export const zaiProviderAdapter = new ZaiProviderAdapter();

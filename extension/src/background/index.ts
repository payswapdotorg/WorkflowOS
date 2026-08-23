/**
 * WorkflowOS Companion — MV3 background service worker (§12).
 *
 * Owns: execution sessions, the WorkflowOS client + reporter, provider
 * adapter lifecycle, tab lifecycle, and all extension message routing.
 * Content scripts and extension pages stay thin — they only detect, relay,
 * and render.
 *
 * SECURITY INVARIANTS (statically enforced):
 *   - no WorkflowOS API key is ever held, sent, or requested;
 *   - the callback token stays here + in storage.session (memory), never in
 *     localStorage, never messaged to content scripts, never logged;
 *   - the extension calls exactly TWO WorkflowOS endpoints:
 *     POST /companion/redeem and POST /execution/:id/events;
 *   - provider output is data — the worker never evaluates it.
 */
import { WorkflowOsClient } from '../workflowos/client.js';
import { ExecutionReporter } from '../workflowos/reporter.js';
import { chromeSessionStorage } from './store.js';
import { providerRegistry, type ProviderInfo } from '../providers/registry.js';
import { pushFakeObservation } from '../providers/fake/fake-provider-adapter.js';
import type { AdapterRuntime } from '../providers/types.js';
import type { ExternalExecutionSession, SessionView } from '../shared/session.js';
import { toSessionView } from '../shared/session.js';
import {
  isCompanionMessage,
  type CompanionMessage,
  type ExecutionObservationPayload,
} from '../shared/messages.js';

const SESSION_KEY = 'wfos.companion.session.v1';
const QUEUE_KEY = 'wfos.companion.queue.v1';

// --- environment bridge (chrome.* in the worker; injectable in tests) ---

export interface RuntimeBridge {
  onMessage(
    listener: (
      msg: unknown,
      sender: { tab?: { id?: number } },
      respond: (response: unknown) => void,
    ) => boolean | void,
  ): void;
  sendMessage(msg: unknown): Promise<unknown>;
  openTab(url: string): Promise<number | null>;
  closeTab(tabId: number): Promise<void>;
  getExtensionUrl(path: string): string;
}

function createRuntimeBridge(): RuntimeBridge {
  const rt = globalThis.chrome?.runtime;
  const tabs = globalThis.chrome?.tabs;
  return {
    onMessage(listener) {
      rt?.onMessage.addListener(
        (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) =>
          listener(
            msg,
            { tab: sender.tab ? { id: sender.tab.id } : undefined },
            sendResponse,
          ),
      );
    },
    async sendMessage(msg) {
      return rt?.sendMessage(msg) ?? null;
    },
    async openTab(url) {
      if (!tabs?.create) return null;
      const tab = await tabs.create({ url, active: true });
      return tab.id ?? null;
    },
    async closeTab(tabId) {
      await tabs?.remove(tabId);
    },
    getExtensionUrl(path: string) {
      return rt?.getURL(path) ?? path;
    },
  };
}

// --- the companion coordinator ---

export class CompanionBackground {
  private session: ExternalExecutionSession | null = null;
  private reporter: ExecutionReporter | null = null;
  private connectionOnline = true;
  private observationSinkWired = false;
  private handoffAck:
    | ((result: { ok: boolean; executionId?: string; provider?: string; error?: string }) => void)
    | null = null;

  constructor(
    private readonly runtime: RuntimeBridge,
    private readonly store: ReturnType<typeof chromeSessionStorage>,
    private readonly client: WorkflowOsClient,
    private readonly makeReporter: (client: WorkflowOsClient) => ExecutionReporter,
    private readonly adapterRuntime: AdapterRuntime,
    private readonly log: (...args: unknown[]) => void = () => {},
  ) {}

  async init(): Promise<void> {
    // Restore the session from the previous worker instance (storage.session
    // is memory-backed — survives worker restarts, cleared on browser close).
    this.session = await this.store.getJson<ExternalExecutionSession>(SESSION_KEY);
    if (this.session) {
      this.reporter = this.makeReporter(this.client);
      await this.reporter.restore();
      void this.reporter.flush(this.session);
    }
    this.runtime.onMessage((msg, sender, respond) => {
      if (!isCompanionMessage(msg)) return false;
      void this.handle(msg as CompanionMessage, sender, respond);
      return true; // async response
    });
  }

  /** Test hook to observe handoff outcomes without runtime messaging. */
  setHandoffAck(
    ack: (result: { ok: boolean; executionId?: string; provider?: string; error?: string }) => void,
  ): void {
    this.handoffAck = ack;
  }

  private async handle(
    msg: CompanionMessage,
    sender: { tab?: { id?: number } },
    respond: (response: unknown) => void,
  ): Promise<void> {
    switch (msg.type) {
      case 'WORKFLOWOS_HANDOFF': {
        const result = await this.onHandoff(msg.payload.ref, msg.payload.origin);
        respond(result);
        break;
      }
      case 'PROVIDER_DETECTED':
        this.log('provider detected', msg.payload.providerId, 'adapter:', msg.payload.adapterAvailable);
        respond({ ok: true });
        break;
      case 'START_EXECUTION':
        await this.startObserving();
        respond({ ok: true });
        break;
      case 'STOP_EXECUTION':
        await this.stopSession();
        respond({ ok: true });
        break;
      case 'OPEN_PROVIDER':
        await this.openProvider();
        respond({ ok: true });
        break;
      case 'RESUME_SESSION':
        await this.resumeSession();
        respond({ ok: true });
        break;
      case 'EXECUTION_PROGRESS':
      case 'EXECUTION_COMPLETED':
      case 'EXECUTION_FAILED':
      case 'EXECUTION_BLOCKED':
        await this.onExecutionMessage(msg.type, msg.payload, msg.executionId);
        respond({ ok: true });
        break;
      case 'GET_STATE':
        respond(this.getState());
        break;
      case 'GET_SESSION':
        respond(this.getSessionView());
        break;
      case 'PROMPT_SUBMITTED': {
        // §28/§38.4: mark submitted EXACTLY once — persisted so a reload
        // never triggers a second submission.
        if (this.session && msg.executionId === this.session.executionId && !this.session.promptSubmitted) {
          this.session.promptSubmitted = true;
          this.session.phase = 'task-sent';
          if (msg.payload.externalSessionRef) {
            this.session.externalSessionRef = msg.payload.externalSessionRef;
          }
          await this.store.setJson(SESSION_KEY, this.session);
        }
        respond({ ok: true });
        break;
      }
      case 'PROVIDER_STATUS': {
        // §9: visible provider phase for the popup. NOTE: the BLOCKED reason
        // from the observation path (human-readable, e.g. "Please sign in to
        // Z.ai.") takes precedence — the phase detail here is a terse code.
        if (this.session && msg.executionId === this.session.executionId) {
          this.session.phase = msg.payload.phase;
          if (msg.payload.phase === 'blocked' && msg.payload.detail && !this.session.blockedReason) {
            this.session.blockedReason = msg.payload.detail;
          }
          await this.store.setJson(SESSION_KEY, this.session);
        }
        respond({ ok: true });
        break;
      }
      case 'BRIDGE_READY': {
        // The provider adapter bridge is live — if the prompt has not been
        // submitted yet, command the injection (idempotent; the page runtime
        // also self-attaches on load).
        if (this.session && !this.session.promptSubmitted) {
          await this.startObserving();
        }
        respond({ ok: true });
        break;
      }
      case 'COMPANION_PING':
      case 'COMPANION_PONG':
      case 'WORKFLOWOS_HANDOFF_RESULT':
        respond({ ok: true });
        break;
    }
    void sender;
  }

  // --- handoff (§7): redeem the one-time reference, build the session ---

  async onHandoff(
    ref: string,
    origin: string,
  ): Promise<{ ok: boolean; executionId?: string; provider?: string; error?: string }> {
    try {
      const redeemed = await this.client.redeemHandoff(origin, ref);
      this.session = {
        executionId: redeemed.execution.executionId,
        provider: redeemed.execution.provider,
        providerLabel: redeemed.package.provider,
        projectId: redeemed.execution.projectId,
        workItemId: redeemed.execution.workItemId,
        workItemLabel: redeemed.package.workItemLabel,
        repository: redeemed.execution.repository,
        branch: redeemed.package.branch,
        prompt: redeemed.package.prompt,
        structuredInstructions: redeemed.package.structuredInstructions,
        verificationRequirements: redeemed.package.verificationRequirements,
        expectedOutputs: redeemed.package.expectedOutputs,
        promptDigest: redeemed.execution.promptDigest,
        workflowosOrigin: origin,
        callback: {
          token: redeemed.callbackToken,
          expiresAt: redeemed.callbackExpiresAt,
          origin,
        },
        status: 'ready',
        startedAt: null,
        openedTabId: null,
        promptSubmitted: false,
        phase: 'connecting',
        blockedReason: null,
        externalSessionRef: null,
      };
      await this.store.setJson(SESSION_KEY, this.session);
      this.reporter = this.makeReporter(this.client);
      this.observationSinkWired = false;
      this.log('session opened', this.session.executionId, this.session.provider);
      // §1 flow: session established → open the provider.
      await this.openProvider();
      const okResult = {
        ok: true,
        executionId: this.session.executionId,
        provider: this.session.provider,
      };
      this.handoffAck?.(okResult);
      return okResult;
    } catch (err) {
      const error = (err as Error).message;
      this.log('handoff failed', error);
      const failResult = { ok: false, error };
      this.handoffAck?.(failResult);
      return failResult;
    }
  }

  // --- provider session lifecycle ---

  async openProvider(): Promise<void> {
    if (!this.session) return;
    const adapter = providerRegistry.get(this.session.provider);
    if (!adapter) {
      this.session.status = 'blocked';
      await this.store.setJson(SESSION_KEY, this.session);
      return;
    }
    const tabId = await adapter.openTask(this.toAdapterSession(), this.adapterRuntime);
    this.session.openedTabId = tabId;
    await this.store.setJson(SESSION_KEY, this.session);
    await this.startObserving();
  }

  async startObserving(): Promise<void> {
    if (!this.session) return;
    if (!this.reporter) this.reporter = this.makeReporter(this.client);
    const adapter = providerRegistry.get(this.session.provider);
    if (!adapter) return;
    if (!this.observationSinkWired) {
      this.observationSinkWired = true;
      await adapter.observeExecution(this.toAdapterSession(), this.adapterRuntime, (observation) => {
        void this.onObservation(observation);
      });
      // WORK-029: real providers need an explicit prompt injection command
      // (the fake page self-drives). Idempotent: the adapter + page runtime
      // both refuse when the prompt was already submitted.
      if (adapter.capabilities.injectPrompt && !this.session.promptSubmitted) {
        await adapter.injectPrompt(
          { ...this.toAdapterSession(), promptSubmitted: this.session.promptSubmitted },
          this.adapterRuntime,
        );
      }
      // The provider session has begun → report `started` exactly once
      // (§25: execution.started). Subsequent lifecycle events come from the
      // adapter's observations.
      if (this.session.status === 'ready') {
        this.session.status = 'running';
        this.session.startedAt = Date.now();
        await this.store.setJson(SESSION_KEY, this.session);
        await this.reporter.report(this.session, {
          eventType: 'started',
          externalSessionRef: `companion-${this.session.provider}-${this.session.executionId}`,
        });
      }
    }
  }

  /** Adapter sessions NEVER include the callback token. */
  private toAdapterSession() {
    const s = this.session!;
    return {
      executionId: s.executionId,
      provider: s.provider,
      workItemLabel: s.workItemLabel,
      repository: s.repository,
      branch: s.branch,
      prompt: s.prompt,
      verificationRequirements: s.verificationRequirements,
    };
  }

  private async onObservation(
    observation: {
      kind: 'progress' | 'completed' | 'failed' | 'blocked' | 'note';
    } & ExecutionObservationPayload,
  ): Promise<void> {
    if (!this.session || !this.reporter) return;
    const payload: ExecutionObservationPayload = {
      output: observation.output,
      branch: observation.branch,
      commitRef: observation.commitRef,
      pullRequestRef: observation.pullRequestRef,
      testSummary: observation.testSummary,
      externalSessionRef: observation.externalSessionRef,
    };
    switch (observation.kind) {
      case 'progress':
        if (this.session.status !== 'completed' && this.session.status !== 'failed') {
          this.session.status = 'running';
        }
        if (observation.externalSessionRef && !this.session.externalSessionRef) {
          this.session.externalSessionRef = observation.externalSessionRef;
        }
        await this.reporter.report(this.session, { eventType: 'progress', ...payload });
        break;
      case 'completed':
        this.session.status = 'completed';
        await this.reporter.report(this.session, { eventType: 'completed', ...payload });
        break;
      case 'failed':
        this.session.status = 'failed';
        await this.reporter.report(this.session, { eventType: 'failed', ...payload });
        break;
      case 'blocked':
        this.session.status = 'blocked';
        this.session.blockedReason =
          (observation as { reason?: string }).reason ?? 'Provider blocked automatic execution.';
        await this.reporter.report(this.session, {
          eventType: 'failed',
          ...payload,
          output: payload.output ?? this.session.blockedReason,
        });
        break;
      case 'note':
        break;
    }
    await this.store.setJson(SESSION_KEY, this.session);
  }

  async onExecutionMessage(
    type: 'EXECUTION_PROGRESS' | 'EXECUTION_COMPLETED' | 'EXECUTION_FAILED' | 'EXECUTION_BLOCKED',
    payload: ExecutionObservationPayload,
    executionId: string | null,
  ): Promise<void> {
    if (!this.session) return;
    // Extension pages identify their execution; cross-execution messages are dropped.
    if (executionId && executionId !== this.session.executionId) return;
    const kind =
      type === 'EXECUTION_PROGRESS'
        ? 'progress'
        : type === 'EXECUTION_COMPLETED'
          ? 'completed'
          : type === 'EXECUTION_FAILED'
            ? 'failed'
            : 'blocked';
    if (this.session.provider === 'fake') {
      // Route through the fake adapter so its observation buffer + sinks fire.
      pushFakeObservation(this.session.executionId, { kind, ...payload });
      return;
    }
    await this.onObservation({ kind, ...payload });
  }

  async stopSession(): Promise<void> {
    if (!this.session) return;
    const adapter = providerRegistry.get(this.session.provider);
    if (adapter) {
      await adapter.stop(this.toAdapterSession(), this.adapterRuntime);
      if (this.session.openedTabId !== null) {
        await this.runtime.closeTab(this.session.openedTabId).catch(() => undefined);
      }
    }
    this.reporter?.stop();
    this.session.status = 'stopped';
    await this.store.setJson(SESSION_KEY, this.session);
  }

  async resumeSession(): Promise<void> {
    if (!this.session) return;
    if (['stopped', 'ready', 'blocked'].includes(this.session.status)) {
      this.session.status = 'ready';
      await this.openProvider();
    }
  }

  setConnectionOnline(online: boolean): void {
    this.connectionOnline = online;
  }

  // --- popup queries ---

  getState(): {
    session: SessionView | null;
    connection: 'connected' | 'offline';
    pendingEvents: number;
    providers: ProviderInfo[];
    pendingProviderMetadata: { providerId: string; displayName: string; workItem: string }[];
  } {
    return {
      session: this.session ? toSessionView(this.session) : null,
      connection: this.connectionOnline ? 'connected' : 'offline',
      pendingEvents: this.reporter?.pendingCount ?? 0,
      providers: providerRegistry.listProviders(),
      pendingProviderMetadata: [...providerRegistry.pendingProviders],
    };
  }

  getSessionView(): SessionView | null {
    return this.session ? toSessionView(this.session) : null;
  }
}

// --- worker entry ---

async function bootstrap(): Promise<void> {
  const runtime = createRuntimeBridge();
  const area = globalThis.chrome?.storage?.session;
  const store = chromeSessionStorage(area ?? createMemoryArea());
  const companion = new CompanionBackground(
    runtime,
    store,
    new WorkflowOsClient(
      (input, init) => fetch(input, init),
      () => companion.setConnectionOnline(false),
      () => companion.setConnectionOnline(true),
    ),
    (client) =>
      new ExecutionReporter(client, {
        loadQueue: async () =>
          (await store.getJson<{ event: never; attempts: number }[]>(QUEUE_KEY)) ?? [],
        saveQueue: async (queue: unknown[]) => {
          await store.setJson(QUEUE_KEY, queue);
        },
      }),
    {
      openTab: (url) => runtime.openTab(url),
      closeTab: (tabId) => runtime.closeTab(tabId),
      getActiveTabId: async () => null,
      extensionPageUrl: (path, params) => {
        const url = new URL(runtime.getExtensionUrl(path.replace(/^\//, '')));
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        return url.toString();
      },
    },
  );
  await companion.init();
}

/** In-memory storage.session fallback for non-extension contexts (tests). */
function createMemoryArea() {
  const mem = new Map<string, string>();
  return {
    async get(keys: string[]): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (mem.has(k)) out[k] = mem.get(k);
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [k, v] of Object.entries(items)) mem.set(k, v as string);
    },
    async remove(keys: string[]): Promise<void> {
      for (const k of keys) mem.delete(k);
    },
  };
}

// Only auto-boot in a real extension worker (unit tests import the class).
if (typeof globalThis.chrome?.runtime?.id === 'string') {
  void bootstrap();
}

/**
 * WorkflowOS Companion — provider adapter contracts (§10, §11).
 *
 * The contract is PROVIDER-NEUTRAL: no DOM selectors, no provider URLs, no
 * platform-specific behavior. Real adapters (Z.ai = WORK-029, ChatGPT =
 * WORK-030, Claude = WORK-031) implement this interface in their own
 * isolated files; WORK-028 ships only the deterministic FAKE adapter
 * (extension-page based — no DOM scraping at all).
 */

// --- WORK-030 (PR #33 review): provider SURFACE capability model -----------
//
// The ChatGPT product distinguishes Chat (conversational), Work, and Codex
// (the coding environment). WorkflowOS implementation Work Orders must run
// on the provider's CODING surface where the provider model requires it —
// a conversational chat accepting the prompt is NOT implementation
// execution, and the adapter never silently falls back between surfaces.

export type ProviderSurfaceKind = 'conversational-chat' | 'coding-agent';
export type SurfaceReadiness = 'ready' | 'unverified' | 'not-available';

export interface ProviderSurfaceCapabilities {
  readonly conversationalChat: SurfaceReadiness;
  readonly codingAgent: SurfaceReadiness;
  /** The surface implementation Work Orders MUST use for this provider. */
  readonly implementationSurface: ProviderSurfaceKind;
}

/** A detected page surface (confidence-gated like every DOM decision). */
export interface DetectedSurface {
  readonly surface: 'conversational-chat' | 'coding-agent' | 'work' | 'unknown';
  readonly confidence: 'high' | 'medium' | 'none';
  readonly via: string;
}

/** One observation from a provider page (always untrusted data). */
export interface ProviderObservation {
  readonly kind: 'progress' | 'completed' | 'failed' | 'blocked' | 'note';
  readonly output?: string;
  readonly branch?: string;
  readonly commitRef?: string;
  readonly pullRequestRef?: string;
  readonly testSummary?: Record<string, unknown>;
  readonly externalSessionRef?: string;
}

/** What an adapter may ask the runtime to do (open tabs, message pages). */
export interface AdapterRuntime {
  /** Open a tab and return its id. */
  openTab(url: string): Promise<number | null>;
  /** Close a tab. */
  closeTab(tabId: number): Promise<void>;
  /** Active tab id (or null). */
  getActiveTabId(): Promise<number | null>;
  /** Extension-internal page URL (e.g. the fake provider page). */
  extensionPageUrl(path: string, params: Record<string, string>): string;
}

/** Read-only session shape adapters receive (NO callback token). */
export type AdapterSession = {
  readonly executionId: string;
  readonly provider: string;
  readonly workItemLabel: string;
  readonly repository: string | null;
  readonly branch: string;
  readonly prompt: string;
  readonly verificationRequirements: readonly string[];
  /**
   * WORK-029 (optional, additive): true once the prompt was submitted for
   * this execution — adapters use it to refuse duplicate submission.
   */
  readonly promptSubmitted?: boolean;
};

/** Where observations flow (the background wires this to the reporter). */
export type ObservationSink = (observation: ProviderObservation) => void;

/**
 * A provider adapter. Capabilities are declared so the popup/registry can
 * surface what is implemented without instantiating platform logic.
 */
export interface ExternalProviderAdapter {
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: {
    readonly openTask: boolean;
    readonly injectPrompt: boolean;
    readonly observe: boolean;
  };
  /** Whether a given page URL belongs to this provider. */
  matchesPage(url: URL): boolean;
  /** Open the provider with the task (target tab id returned). */
  openTask(session: AdapterSession, runtime: AdapterRuntime): Promise<number | null>;
  /** Inject the prompt into an ALREADY OPEN provider page (WORK-029+). */
  injectPrompt(session: AdapterSession, runtime: AdapterRuntime): Promise<void>;
  /** Start observing the provider page for this execution. */
  observeExecution(session: AdapterSession, runtime: AdapterRuntime, sink: ObservationSink): Promise<void>;
  /** Classify a raw observation. */
  detectCompletion(observation: ProviderObservation): boolean;
  detectFailure(observation: ProviderObservation): boolean;
  /** Collect buffered observations (pull model; may be empty). */
  collectObservations(session: AdapterSession): Promise<ProviderObservation[]>;
  /** Stop observing / close provider resources for the session. */
  stop(session: AdapterSession, runtime: AdapterRuntime): Promise<void>;
  /**
   * WORK-030 (PR #33 review): declare this provider's surface capabilities
   * (conversational vs coding-agent + which surface implementation uses).
   * Optional + additive — adapters predating the surface model report the
   * registry's catalog defaults.
   */
  describeSurfaces?(): ProviderSurfaceCapabilities;
}

export interface ProviderDetection {
  readonly providerId: string | null;
  readonly supported: boolean;
  readonly adapterAvailable: boolean;
}

/**
 * WORK-030: ChatGPT adapter types.
 *
 * All ChatGPT-specific type surface lives here. Nothing may reference
 * credentials — the adapter operates on a token-free session view fetched
 * from the background (GET_STATE) and reports observations through the
 * background's existing reporter.
 */

/** Adapter configuration (background side). */
export interface ChatgptAdapterConfig {
  /** Production ChatGPT origin. */
  readonly chatgptOrigin: string;
  /**
   * TEST fixture origin (e.g. http://127.0.0.1:3778). When staged via
   * chrome.storage.session 'wfos.chatgpt.fixtureOrigin' (E2E harness), the
   * adapter opens/matches the local fixture reproducing the observed
   * ChatGPT DOM instead of the real site. Never set in production.
   */
  readonly fixtureOrigin?: string;
}

/** Token-free page-session payload consumed by the bridge runtime. */
export interface ChatgptPageSession {
  readonly executionId: string;
  readonly workItemLabel: string;
  readonly provider: string;
  readonly repository: string | null;
  readonly branch: string;
  /** The EXACT deterministic prompt produced by WorkflowOS. */
  readonly prompt: string;
  /** sha256(prompt) — the identity check before submission. */
  readonly promptDigest: string;
  /** True once the prompt was submitted for this execution (reload guard). */
  readonly promptSubmitted: boolean;
}

/** Visible provider phases surfaced in the extension UI. */
export type ChatgptPhase =
  | 'connecting'
  | 'provider-detected'
  | 'prompt-ready'
  | 'prompt-inserted'
  | 'task-sent'
  | 'agent-running'
  | 'completed'
  | 'failed'
  | 'blocked';

/** In-page observation kinds (never authority outcomes). */
export type ChatgptObservationKind =
  | 'started'
  | 'progress'
  | 'completed'
  | 'failed'
  | 'blocked';

export interface ChatgptObservation {
  readonly kind: ChatgptObservationKind;
  readonly executionId: string;
  readonly output?: string;
  readonly branch?: string;
  readonly commitRef?: string;
  readonly pullRequestRef?: string;
  readonly testSummary?: Record<string, unknown>;
  readonly externalSessionRef?: string;
  /** Human-readable BLOCKED reason (login required, UI changed, …). */
  readonly reason?: string;
}

/** Conversation scope guard: observations only flow inside this path. */
export interface ChatgptConversationScope {
  conversationPath: string | null;
}

/** Result of the page attach (logging/tests). */
export interface ChatgptAttachResult {
  attached: boolean;
  phase: ChatgptPhase;
  detail?: string;
}

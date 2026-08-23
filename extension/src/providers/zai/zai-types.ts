/**
 * WORK-029: Z.ai adapter types.
 *
 * All Z.ai-specific type surface lives here. Nothing in this file may
 * reference credentials of any kind — the adapter operates on a TOKEN-FREE
 * session view fetched from the background (GET_STATE) and reports
 * observations back through the background's reporter.
 */

/** Adapter configuration (background side). */
export interface ZaiAdapterConfig {
  /** Production Z.ai origin. */
  readonly zaiOrigin: string;
  /**
   * TEST fixture origin (e.g. http://127.0.0.1:3777). When set — via
   * chrome.storage.session 'wfos.zai.fixtureOrigin' by the WORK-029 E2E
   * harness — the adapter opens/matches the local fixture that reproduces
   * the observed Z.ai DOM instead of the real site. Never set in production.
   */
  readonly fixtureOrigin?: string;
}

/** Token-free page-session payload the bridge runtime consumes. */
export interface ZaiPageSession {
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

/** Provider-neutral page phases surfaced in the extension UI (§9). */
export type ZaiPhase =
  | 'connecting'
  | 'provider-detected'
  | 'prompt-ready'
  | 'prompt-inserted'
  | 'task-sent'
  | 'agent-running'
  | 'completed'
  | 'failed'
  | 'blocked';

/** In-page observation kinds the runtime emits (never authority outcomes). */
export type ZaiObservationKind =
  | 'started'
  | 'progress'
  | 'completed'
  | 'failed'
  | 'blocked';

export interface ZaiObservation {
  readonly kind: ZaiObservationKind;
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

/** Which conversation this runtime may observe (scope guard §16). */
export interface ZaiConversationScope {
  /** Conversation path recorded at submit time (e.g. /chat/<uuid>). */
  conversationPath: string | null;
}

/** Aggregate result of the page attach (for logging/tests). */
export interface ZaiAttachResult {
  attached: boolean;
  phase: ZaiPhase;
  detail?: string;
}

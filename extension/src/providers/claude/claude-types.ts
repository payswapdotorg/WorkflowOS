/**
 * WORK-031: Claude adapter types.
 *
 * All ChatGPT-specific type surface lives here. Nothing may reference
 * credentials — the adapter operates on a token-free session view fetched
 * from the background (GET_STATE) and reports observations through the
 * background's existing reporter.
 */

/** Adapter configuration (background side). */
export interface ClaudeAdapterConfig {
  /** Production Claude origin. */
  readonly claudeOrigin: string;
  /**
   * TEST fixture origin (e.g. http://127.0.0.1:3779). When staged via
   * chrome.storage.session 'wfos.claude.fixtureOrigin' (E2E harness), the
   * adapter opens/matches the local fixture reproducing the observed
   * ChatGPT DOM instead of the real site. Never set in production.
   */
  readonly fixtureOrigin?: string;
}

/** Token-free page-session payload consumed by the bridge runtime. */
/** The kind of task being executed — decides the required surface. */
export type ClaudeTaskKind = 'implementation' | 'conversational';

export interface ClaudePageSession {
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
  /**
   * WORK-030 (PR #33 review): WorkflowOS external executions are
   * implementation Work Orders — they REQUIRE the coding-agent surface
   * (Codex). 'conversational' keeps the generic Chat surface usable where
   * useful, but implementation NEVER silently falls back to it.
   */
  readonly taskKind: ClaudeTaskKind;
}

/** Visible provider phases surfaced in the extension UI. */
export type ClaudePhase =
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
export type ClaudeObservationKind =
  | 'started'
  | 'progress'
  | 'completed'
  | 'failed'
  | 'blocked';

export interface ClaudeObservation {
  readonly kind: ClaudeObservationKind;
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
export interface ClaudeConversationScope {
  conversationPath: string | null;
}

/** Result of the page attach (logging/tests). */
export interface ClaudeAttachResult {
  attached: boolean;
  phase: ClaudePhase;
  detail?: string;
}

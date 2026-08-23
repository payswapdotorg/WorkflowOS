/**
 * WorkflowOS Companion — session model (§9).
 *
 * The extension-internal representation of ONE external execution. Built
 * exclusively from the WORK-028 companion redemption response. Contains NO
 * raw credentials except the scoped callback token, which lives in the
 * service worker + chrome.storage.session (memory-backed, cleared when the
 * browser closes — never localStorage, never disk-synced storage.local).
 */

/** Extension-side session status (distinct from backend execution state). */
export type CompanionSessionStatus =
  | 'connecting'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'stopped'
  | 'expired';

/** The scoped event-ingestion credential (WORK-027 PR #30 fix #2). */
export interface CallbackCapability {
  /** The raw callback token — memory only, never logged, never persisted to disk. */
  readonly token: string;
  readonly expiresAt: string;
  /** WorkflowOS origin events are posted to. */
  readonly origin: string;
}

export interface ExternalExecutionSession {
  readonly executionId: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly workItemLabel: string;
  readonly repository: string | null;
  readonly branch: string;
  /** Deterministic implementation prompt (from the redeemed package). */
  readonly prompt: string;
  readonly structuredInstructions: readonly string[];
  readonly verificationRequirements: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly promptDigest: string;
  readonly workflowosOrigin: string;
  readonly callback: CallbackCapability;
  status: CompanionSessionStatus;
  startedAt: number | null;
  openedTabId: number | null;
  /**
   * WORK-029: true once the provider prompt was submitted for this
   * execution — persisted so a page reload NEVER resubmits (§28).
   */
  promptSubmitted: boolean;
  /** WORK-029: visible provider phase for the popup (§9). */
  phase: string | null;
  /** WORK-029: human-readable reason while BLOCKED (§26). */
  blockedReason: string | null;
  /** WORK-029: provider conversation reference (safe metadata, e.g. URL path). */
  externalSessionRef: string | null;
}

/** Serializable view for the popup / provider pages — NO token material. */
export interface SessionView {
  readonly executionId: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly workItemLabel: string;
  readonly repository: string | null;
  readonly branch: string;
  readonly status: CompanionSessionStatus;
  readonly startedAt: number | null;
  readonly prompt: string;
  readonly promptDigest: string;
  readonly verificationRequirements: readonly string[];
  readonly workflowosOrigin: string;
  readonly promptSubmitted: boolean;
  readonly phase: string | null;
  readonly blockedReason: string | null;
  readonly externalSessionRef: string | null;
}

export function toSessionView(session: ExternalExecutionSession): SessionView {
  // Deliberately excludes callback.token — views are token-free.
  return {
    executionId: session.executionId,
    provider: session.provider,
    providerLabel: session.providerLabel,
    workItemLabel: session.workItemLabel,
    repository: session.repository,
    branch: session.branch,
    status: session.status,
    startedAt: session.startedAt,
    prompt: session.prompt,
    promptDigest: session.promptDigest,
    verificationRequirements: session.verificationRequirements,
    workflowosOrigin: session.workflowosOrigin,
    promptSubmitted: session.promptSubmitted,
    phase: session.phase,
    blockedReason: session.blockedReason,
    externalSessionRef: session.externalSessionRef,
  };
}

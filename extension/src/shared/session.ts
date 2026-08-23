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
  readonly verificationRequirements: readonly string[];
  readonly workflowosOrigin: string;
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
    verificationRequirements: session.verificationRequirements,
    workflowosOrigin: session.workflowosOrigin,
  };
}

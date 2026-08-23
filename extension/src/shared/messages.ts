/**
 * WorkflowOS Companion — typed message protocol (§14).
 *
 * Discriminated TypeScript unions for every message crossing an extension
 * boundary (content script ⇄ service worker ⇄ extension pages). Every
 * message carries: type, executionId (nullable for global messages),
 * timestamp, payload.
 *
 * SECURITY: no message payload ever contains a WorkflowOS API key, a GitHub
 * token, or any provider credential. The only credential in flight is the
 * scoped callback token, which lives in the service worker + storage.session
 * and is never messaged to content scripts or logged.
 */

/** Message envelope discriminant. */
export const MESSAGE_TYPES = [
  // Handoff + lifecycle
  'WORKFLOWOS_HANDOFF',
  'WORKFLOWOS_HANDOFF_RESULT',
  'COMPANION_PING',
  'COMPANION_PONG',
  // Provider detection + WORK-029 bridge lifecycle
  'PROVIDER_DETECTED',
  'BRIDGE_READY',
  'PROMPT_SUBMITTED',
  'PROVIDER_STATUS',
  // Execution control
  'START_EXECUTION',
  'STOP_EXECUTION',
  'OPEN_PROVIDER',
  'RESUME_SESSION',
  // Execution observations
  'EXECUTION_PROGRESS',
  'EXECUTION_COMPLETED',
  'EXECUTION_FAILED',
  'EXECUTION_BLOCKED',
  // Popup queries
  'GET_STATE',
  'GET_SESSION',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface MessageEnvelope<T extends MessageType, P> {
  readonly type: T;
  readonly executionId: string | null;
  readonly timestamp: number;
  readonly payload: P;
}

// --- Handoff (WorkflowOS origin → background) ---

/** Content script found /companion/handoff#ref=… on the WorkflowOS origin. */
export interface WorkflowOsHandoffPayload {
  /** One-time opaque handoff reference (the WORK-027 handoff token). */
  readonly ref: string;
  /** WorkflowOS origin the reference must be redeemed against. */
  readonly origin: string;
  /** Execution id (UI convenience — the extension trusts only the ref). */
  readonly executionId?: string;
}
export type WorkflowOsHandoffMessage = MessageEnvelope<'WORKFLOWOS_HANDOFF', WorkflowOsHandoffPayload>;

/** Background → content script: handoff consumption outcome (no tokens). */
export interface WorkflowOsHandoffResultPayload {
  readonly ok: boolean;
  readonly executionId?: string;
  readonly provider?: string;
  readonly error?: string;
}
export type WorkflowOsHandoffResultMessage = MessageEnvelope<'WORKFLOWOS_HANDOFF_RESULT', WorkflowOsHandoffResultPayload>;

// --- Companion install detection (WorkflowOS page ⇄ content script) ---

/** DOM-side ping dispatched by the WorkflowOS SPA; answered with COMPANION_PONG. */
export type CompanionPingMessage = MessageEnvelope<'COMPANION_PING', Record<string, never>>;
export type CompanionPongMessage = MessageEnvelope<'COMPANION_PONG', { version: string }>;

// --- Provider detection (provider origin content script → background) ---

export interface ProviderDetectedPayload {
  readonly providerId: string;
  readonly supported: boolean;
  readonly adapterAvailable: boolean;
  readonly url: string;
}
export type ProviderDetectedMessage = MessageEnvelope<'PROVIDER_DETECTED', ProviderDetectedPayload>;

// --- WORK-029: provider bridge lifecycle (provider-neutral envelopes) ---

/** A provider page's adapter bridge finished loading and is ready (§5). */
export type BridgeReadyMessage = MessageEnvelope<'BRIDGE_READY', { providerId: string }>;

/** The provider page submitted the prompt for this execution — EXACTLY ONCE. */
export type PromptSubmittedMessage = MessageEnvelope<
  'PROMPT_SUBMITTED',
  { externalSessionRef?: string }
>;

/** Visible provider phase for the extension UI (§9). */
export type ProviderStatusMessage = MessageEnvelope<
  'PROVIDER_STATUS',
  { phase: string; detail?: string }
>;

// --- Execution control (popup / pages → background) ---

export type StartExecutionMessage = MessageEnvelope<'START_EXECUTION', { auto: boolean }>;
export type StopExecutionMessage = MessageEnvelope<'STOP_EXECUTION', { reason?: string }>;
export type OpenProviderMessage = MessageEnvelope<'OPEN_PROVIDER', Record<string, never>>;
export type ResumeSessionMessage = MessageEnvelope<'RESUME_SESSION', Record<string, never>>;

// --- Execution observations (provider adapters → background) ---

/** Reported observations — NEVER authoritative WorkflowOS outcomes. */
export interface ExecutionObservationPayload {
  /** Human-readable observation text (untrusted provider output). */
  readonly output?: string;
  readonly branch?: string;
  readonly commitRef?: string;
  readonly pullRequestRef?: string;
  readonly testSummary?: Record<string, unknown>;
  readonly externalSessionRef?: string;
  /** WORK-029: human-readable BLOCKED reason (login required, UI changed…). */
  readonly reason?: string;
}
export type ExecutionProgressMessage = MessageEnvelope<'EXECUTION_PROGRESS', ExecutionObservationPayload>;
export type ExecutionCompletedMessage = MessageEnvelope<'EXECUTION_COMPLETED', ExecutionObservationPayload>;
export type ExecutionFailedMessage = MessageEnvelope<'EXECUTION_FAILED', { reason?: string } & ExecutionObservationPayload>;
export type ExecutionBlockedMessage = MessageEnvelope<'EXECUTION_BLOCKED', { reason?: string } & ExecutionObservationPayload>;

// --- Popup queries ---

export type GetStateMessage = MessageEnvelope<'GET_STATE', Record<string, never>>;
export type GetSessionMessage = MessageEnvelope<'GET_SESSION', Record<string, never>>;

/** The full discriminated union (§31: "common message protocol is typed"). */
export type CompanionMessage =
  | WorkflowOsHandoffMessage
  | WorkflowOsHandoffResultMessage
  | CompanionPingMessage
  | CompanionPongMessage
  | ProviderDetectedMessage
  | BridgeReadyMessage
  | PromptSubmittedMessage
  | ProviderStatusMessage
  | StartExecutionMessage
  | StopExecutionMessage
  | OpenProviderMessage
  | ResumeSessionMessage
  | ExecutionProgressMessage
  | ExecutionCompletedMessage
  | ExecutionFailedMessage
  | ExecutionBlockedMessage
  | GetStateMessage
  | GetSessionMessage;

/** Runtime narrowing helper. */
export function isCompanionMessage(value: unknown): value is CompanionMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as { type?: unknown; timestamp?: unknown };
  return (
    typeof m.type === 'string' &&
    (MESSAGE_TYPES as readonly string[]).includes(m.type) &&
    typeof m.timestamp === 'number'
  );
}

/** Envelope factory used by every sender. */
export function message<T extends MessageType, P>(
  type: T,
  executionId: string | null,
  payload: P,
): MessageEnvelope<T, P> {
  return { type, executionId, timestamp: Date.now(), payload };
}

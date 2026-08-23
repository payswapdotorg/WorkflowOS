/**
 * WorkflowOS Companion — WorkflowOSClient.
 *
 * The ONLY two WorkflowOS endpoints the extension may call (statically
 * enforced):
 *
 *   POST /companion/redeem            (x-handoff-token — one-time, no API key)
 *   POST /execution/:id/events        (x-callback-token — scoped, no API key)
 *
 * The extension NEVER holds, sends, or sees a WorkflowOS API key
 * (no x-api-key, no Authorization headers — statically enforced).
 */
import type { ExternalExecutionSession } from '../shared/session.js';

export interface RedeemedExecutionSummary {
  executionId: string;
  projectId: string;
  workItemId: string;
  mode: string;
  provider: string;
  model: string | null;
  status: string;
  repository: string | null;
  branch: string | null;
  promptDigest: string;
  expiresAt: string | null;
}

export interface RedeemedPackage {
  executionId: string;
  workItemLabel: string;
  provider: string;
  repository: { owner: string | null; name: string | null; url: string | null; defaultBranch: string | null };
  branch: string;
  prompt: string;
  structuredInstructions: string[];
  verificationRequirements: string[];
  expectedOutputs: string[];
  returnCallback: { eventsPath: string; eventTypes: string[]; auth: string; note: string };
  expiration: string;
}

export interface RedemptionResponse {
  execution: RedeemedExecutionSummary;
  package: RedeemedPackage;
  callbackToken: string;
  callbackExpiresAt: string;
}

export interface ExecutionEventRequest {
  eventType: 'started' | 'progress' | 'completed' | 'failed';
  commitRef?: string;
  branch?: string;
  pullRequestRef?: string;
  testSummary?: Record<string, unknown>;
  output?: string;
  externalSessionRef?: string;
  idempotencyKey: string;
}

/** Injectable fetch (tests supply a fake; the worker uses global fetch). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class WorkflowOsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'WorkflowOsError';
  }
}

export class WorkflowOsClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly onOffline?: () => void,
    private readonly onOnline?: () => void,
  ) {}

  /** Redeem a one-time handoff reference (no API key — token is the authority). */
  async redeemHandoff(origin: string, ref: string): Promise<RedemptionResponse> {
    const url = `${origin}/api/companion/redeem`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'x-handoff-token': ref },
      });
    } catch (err) {
      this.onOffline?.();
      throw new WorkflowOsError(`workflowos-unreachable: ${(err as Error).message}`, 0);
    }
    this.onOnline?.();
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new WorkflowOsError(
        body.message ?? body.error ?? `redeem failed (${res.status})`,
        res.status,
        body.error,
      );
    }
    return (await res.json()) as RedemptionResponse;
  }

  /** Report one execution event with the scoped callback token. */
  async sendExecutionEvent(
    session: Pick<ExternalExecutionSession, 'executionId' | 'callback'>,
    event: ExecutionEventRequest,
  ): Promise<{ accepted: boolean; duplicate: boolean; status: string }> {
    const url = `${session.callback.origin}/api/execution/${session.executionId}/events`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'x-callback-token': session.callback.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
      });
    } catch (err) {
      this.onOffline?.();
      throw new WorkflowOsError(`workflowos-unreachable: ${(err as Error).message}`, 0);
    }
    this.onOnline?.();
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new WorkflowOsError(
        body.message ?? body.error ?? `event rejected (${res.status})`,
        res.status,
        body.error,
      );
    }
    return (await res.json()) as { accepted: boolean; duplicate: boolean; status: string };
  }
}

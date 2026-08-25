/**
 * WORK-036: HttpToolExecutor — the governed HTTP family (plain fetch;
 * no provider SDK, no credential store).
 *
 * EXPLICIT + GOVERNED, never arbitrary networking:
 *   * absolute http(s) URLs only (no other schemes, no embedded userinfo);
 *   * an explicit method from the frozen verb set;
 *   * headers are CALLER-EXPLICIT — the executor never adds
 *     authentication, cookies, or any provider credential itself;
 *   * the response body is BOUNDED (byte cap + truncated flag);
 *   * timeout + caller cancellation (AbortSignal composition);
 *   * error semantics: network/transport failures are FAILED OUTCOMES;
 *     an HTTP status (4xx/5xx included) is DATA — `status` is recorded,
 *     never conflated with success/failure of the CAPABILITY.
 *
 * NOT an authority: HTTP 200 is NOT a verification PASS.
 */
import type { Logger } from '@platform/logger.js';
import type {
  HttpToolRequest,
  ToolExecutionOutcome,
  ToolExecutor,
  ToolExecutorContext,
  ToolFamilyRequest,
} from './tool-contracts.js';
import { toolOutcomeError } from './tool-contracts.js';

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export interface HttpToolExecutorDeps {
  readonly logger: Logger;
}

export class HttpToolExecutor implements ToolExecutor {
  readonly family = 'http' as const;

  constructor(private readonly deps: HttpToolExecutorDeps) {}

  async execute(request: ToolFamilyRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    const req = request as HttpToolRequest;
    if (!req || typeof req.url !== 'string' || typeof req.method !== 'string') {
      return toolOutcomeError('tool-invalid-input', 'http request requires a url and a method');
    }
    if (!HTTP_METHODS.has(req.method)) {
      return toolOutcomeError(
        'http-method-forbidden',
        `http method ${JSON.stringify(req.method)} is not in the governed verb set`,
      );
    }

    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return toolOutcomeError('tool-invalid-input', `http url is not parseable: ${JSON.stringify(req.url)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return toolOutcomeError(
        'http-scheme-forbidden',
        `http url scheme must be http or https (got ${JSON.stringify(url.protocol)})`,
      );
    }
    if (url.username !== '' || url.password !== '') {
      return toolOutcomeError(
        'http-userinfo-forbidden',
        'http url must not embed userinfo (user:pass@host) — credentials never ride the URL',
      );
    }

    const maxBytes = Math.max(1, req.maxResponseBytes ?? ctx.limits.maxHttpBodyBytes);
    const timeoutMs = Math.max(1, Math.min(req.timeoutMs ?? ctx.limits.defaultTimeoutMs, ctx.limits.maxTimeoutMs));

    // Compose the caller cancellation with the hard timeout.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signals: AbortSignal[] = [timeoutSignal];
    if (ctx.signal) signals.push(ctx.signal);
    const signal = signals.length === 1 ? timeoutSignal : AbortSignal.any(signals);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (typeof k !== 'string' || typeof v !== 'string' || k.length === 0) {
        return toolOutcomeError('tool-invalid-input', 'http headers must be string→string');
      }
      headers[k] = v;
    }

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        redirect: 'follow',
        signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        if (ctx.signal?.aborted) {
          return toolOutcomeError('cancelled', 'the http invocation was cancelled (caller interruption)');
        }
        return toolOutcomeError('timeout', `the http request exceeded its ${timeoutMs}ms timeout bound`);
      }
      return toolOutcomeError('http-network-error', `the http request failed: ${e.message ?? String(err)}`);
    }

    // Read the body with a hard byte cap (streaming — a lying or absent
    // content-length cannot bypass the bound).
    let body = '';
    let truncated = false;
    try {
      const reader = res.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
              chunks.push(value.subarray(0, Math.max(0, maxBytes - (total - value.byteLength))));
              truncated = true;
              await reader.cancel().catch(() => {});
              break;
            }
            chunks.push(value);
          }
        }
        body = Buffer.concat(chunks).toString('utf8');
      }
    } catch (err) {
      return toolOutcomeError('http-body-read-error', `failed reading the response body: ${(err as Error).message}`);
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });

    this.deps.logger.info('tool.http.completed', {
      method: req.method,
      host: url.host,
      status: res.status,
      durationMs: Date.now() - startedAt,
    });

    // The HTTP status is DATA (recorded on the succeeded capability
    // invocation) — it is NEVER a verification verdict.
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      output: {
        url: req.url,
        finalUrl: res.url,
        status: res.status,
        statusText: res.statusText,
        redirected: res.redirected,
        headers: responseHeaders,
        body,
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        durationMs: Date.now() - startedAt,
      },
      error: null,
      cancelled: false,
      truncated,
    };
  }
}

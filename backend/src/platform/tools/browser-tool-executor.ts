/**
 * WORK-036: BrowserToolExecutor — the EXPLICIT browser abstraction.
 *
 * The core tool contract is NOT coupled to Playwright internals, Chrome
 * CDP types, or any particular provider: the concrete browser driver is
 * an injected {@link BrowserDriver} PORT (neutral navigation/inspection
 * primitives). When no driver is configured the family fails closed with
 * the typed 'browser-driver-unavailable' outcome (governed + observable —
 * never a silent no-op).
 *
 * Browser observations are EVIDENCE ONLY — a browser observation is
 * never workflow/verification authority.
 *
 * Bounds: http(s) URLs only, bounded extracted text, bounded screenshot
 * bytes, per-request timeout + caller cancellation.
 */
import type { Logger } from '@platform/logger.js';
import type {
  BrowserToolRequest,
  ToolFamilyRequest,
  ToolExecutionOutcome,
  ToolExecutor,
  ToolExecutorContext,
} from './tool-contracts.js';
import { toolOutcomeError } from './tool-contracts.js';

/**
 * The neutral browser-driver port. A provider adapter (Playwright, CDP,
 * a hosted browser service, …) implements this behind the tool boundary;
 * its types are provider-independent by construction.
 */
export interface BrowserDriver {
  /** Open (navigate to) an absolute http(s) URL. */
  open(url: string, opts: BrowserDriverCallOptions): Promise<BrowserNavigationResult>;
  /** Click the first element matching the selector. */
  click(selector: string, opts: BrowserDriverCallOptions): Promise<BrowserActionResult>;
  /** Type text into the first element matching the selector. */
  type(selector: string, text: string, opts: BrowserDriverCallOptions): Promise<BrowserActionResult>;
  /** Extract the text content of the first element matching the selector. */
  extract(selector: string, opts: BrowserDriverCallOptions): Promise<BrowserExtractionResult>;
  /** Capture a screenshot of the current page (base64 PNG). */
  screenshot(opts: BrowserDriverCallOptions): Promise<BrowserScreenshotResult>;
}

export interface BrowserDriverCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface BrowserNavigationResult {
  /** The URL actually reached (after any redirects). */
  readonly finalUrl: string;
  /** The page's main resource HTTP status, when the driver exposes it. */
  readonly status: number | null;
  /** The page title, when available. */
  readonly title: string | null;
}

export interface BrowserActionResult {
  /** Whether a matching element was found and acted upon. */
  readonly matched: boolean;
  readonly finalUrl: string;
}

export interface BrowserExtractionResult {
  readonly matched: boolean;
  readonly text: string;
  readonly finalUrl: string;
}

export interface BrowserScreenshotResult {
  /** PNG bytes, base64-encoded (bounded by the executor). */
  readonly base64: string;
  readonly finalUrl: string;
}

export interface BrowserToolExecutorDeps {
  readonly logger: Logger;
  /** The provider browser driver (optional — absent fails closed per call). */
  readonly driver?: BrowserDriver;
}

export class BrowserToolExecutor implements ToolExecutor {
  readonly family = 'browser' as const;

  constructor(private readonly deps: BrowserToolExecutorDeps) {}

  async execute(request: ToolFamilyRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    const req = request as BrowserToolRequest;
    if (!req || typeof req.operation !== 'string') {
      return toolOutcomeError('tool-invalid-input', 'browser request requires an operation');
    }
    const driver = this.deps.driver;
    if (!driver) {
      return toolOutcomeError(
        'browser-driver-unavailable',
        'no browser driver is configured — the browser capability requires a driver adapter behind the tool boundary',
      );
    }
    const timeoutMs = Math.max(1, Math.min(req.timeoutMs ?? ctx.limits.defaultTimeoutMs, ctx.limits.maxTimeoutMs));
    const opts: BrowserDriverCallOptions = { signal: ctx.signal, timeoutMs };

    try {
      switch (req.operation) {
        case 'open': {
          const check = this.checkUrl(req.url);
          if (check) return check;
          const nav = await driver.open(req.url!, opts);
          return this.ok({
            operation: 'open',
            finalUrl: nav.finalUrl,
            status: nav.status,
            title: nav.title,
          });
        }
        case 'click': {
          const check = this.checkSelector(req.selector);
          if (check) return check;
          const act = await driver.click(req.selector!, opts);
          return this.ok({ operation: 'click', selector: req.selector, matched: act.matched, finalUrl: act.finalUrl });
        }
        case 'type': {
          const check = this.checkSelector(req.selector);
          if (check) return check;
          if (typeof req.text !== 'string') {
            return toolOutcomeError('tool-invalid-input', 'browser type requires text');
          }
          const act = await driver.type(req.selector!, req.text, opts);
          return this.ok({
            operation: 'type',
            selector: req.selector,
            textLength: req.text.length,
            matched: act.matched,
            finalUrl: act.finalUrl,
          });
        }
        case 'extract': {
          const check = this.checkSelector(req.selector);
          if (check) return check;
          const ext = await driver.extract(req.selector!, opts);
          const truncated = Buffer.byteLength(ext.text, 'utf8') > ctx.limits.browserMaxTextBytes;
          const text = truncated ? Buffer.from(ext.text).subarray(0, ctx.limits.browserMaxTextBytes).toString('utf8') : ext.text;
          return {
            ...this.ok({
              operation: 'extract',
              selector: req.selector,
              matched: ext.matched,
              text,
              finalUrl: ext.finalUrl,
            }),
            truncated,
          };
        }
        case 'screenshot': {
          const shot = await driver.screenshot(opts);
          const truncated = shot.base64.length > ctx.limits.browserMaxScreenshotBytes;
          const base64 = truncated ? shot.base64.slice(0, ctx.limits.browserMaxScreenshotBytes) : shot.base64;
          return {
            ...this.ok({
              operation: 'screenshot',
              screenshotBase64: base64,
              screenshotBytes: Buffer.byteLength(base64, 'utf8'),
              finalUrl: shot.finalUrl,
            }),
            truncated,
          };
        }
        default:
          return toolOutcomeError('tool-invalid-input', `unknown browser operation ${JSON.stringify(req.operation)}`);
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError' || ctx.signal?.aborted) {
        return toolOutcomeError('cancelled', 'the browser invocation was cancelled (caller interruption)');
      }
      if (e.name === 'TimeoutError') {
        return toolOutcomeError('timeout', `the browser operation exceeded its ${timeoutMs}ms timeout bound`);
      }
      return toolOutcomeError('browser-error', `the browser operation failed: ${e.message ?? String(err)}`);
    }
  }

  private ok(output: Record<string, unknown>): ToolExecutionOutcome {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      output,
      error: null,
      cancelled: false,
      truncated: false,
    };
  }

  private checkUrl(url: string | undefined): ToolExecutionOutcome | null {
    if (typeof url !== 'string' || url.length === 0) {
      return toolOutcomeError('tool-invalid-input', 'browser open requires a url');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return toolOutcomeError('tool-invalid-input', `browser url is not parseable: ${JSON.stringify(url)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return toolOutcomeError('http-scheme-forbidden', 'browser urls must be http(s)');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return toolOutcomeError('http-userinfo-forbidden', 'browser urls must not embed userinfo');
    }
    return null;
  }

  private checkSelector(selector: string | undefined): ToolExecutionOutcome | null {
    if (typeof selector !== 'string' || selector.length === 0 || selector.length > 1024) {
      return toolOutcomeError('tool-invalid-input', 'browser operation requires a non-empty selector (≤ 1024 chars)');
    }
    return null;
  }
}

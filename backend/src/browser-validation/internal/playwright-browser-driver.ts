/**
 * WORK-065 — the Playwright-backed {@link BrowserDriver} adapter.
 *
 * THE BOUNDARY (spec/work-orders/WORK-065.md;
 * spec/architecture/v1.1/validation-model.md §9.2): this is the ONE place
 * browser-automation libraries appear in the repository. The agent-browser
 * style capability (headless browser automation with structured navigation/
 * click/type/snapshot commands) is ONE possible implementation of the
 * browser validation agent contract; the contract is what WORK-065 owns,
 * not a particular vendor.
 *
 * The adapter implements the EXISTING {@link BrowserDriver} port (WORK-036's
 * neutral navigation/inspection port — the same port BrowserToolExecutor
 * wraps). It adds NO second browser abstraction. It performs NO authority:
 *   - it never mutates code, merges PRs, or approves reviews;
 *   - it never mints identities (the TestIdentity is presented upstream);
 *   - it never evaluates evidence (the WORK-064 finalization boundary does);
 *   - it never relaxes the EffectPolicy (the enforcement gate is upstream).
 *
 * Bounds (mirroring BrowserToolExecutor):
 *   - http(s) URLs only (the driver enforces the scheme — no file://, no
 *     userinfo in the URL);
 *   - bounded extracted text (the page's text content, truncated to the
 *     executor's limit — the agent's observation-capture preserves the
 *     truncation marker);
 *   - bounded screenshot bytes (base64 PNG, truncated to the executor's
 *     limit);
 *   - per-call timeout (Playwright's navigation/action timeout — a timeout
 *     surfaces as a TimeoutError, which the agent records as
 *     environment_error).
 *
 * Production wiring: the adapter is constructed with a Playwright `Browser`
 * instance (lazily launched). When no browser is configured (production
 * today), the agent fails closed per call (environment_error — never a
 * silent no-op). The adapter is the explicit binding point for the future
 * architect-authorized production browser driver.
 */
import type {
  Browser as PlaywrightBrowser,
  BrowserContext,
  Page,
} from 'playwright';
import type {
  BrowserDriver,
  BrowserDriverCallOptions,
  BrowserNavigationResult,
  BrowserActionResult,
  BrowserExtractionResult,
  BrowserScreenshotResult,
} from '@platform/tools/browser-tool-executor.js';

/** The PlaywrightBrowserDriver construction options. */
export interface PlaywrightBrowserDriverOptions {
  /**
   * A launched Playwright `Browser` (or a factory that launches one lazily on
   * the first call). When absent, every call fails closed with a typed
   * 'browser-driver-unavailable' outcome (the agent records environment_error).
   */
  readonly browser?: PlaywrightBrowser | (() => Promise<PlaywrightBrowser>);
  /** The default context options (viewport, user agent, extra HTTP headers). */
  readonly contextOptions?: Parameters<PlaywrightBrowser['newContext']>[0];
  /** The maximum extracted text bytes (mirrors BrowserToolExecutor's bound). */
  readonly maxTextBytes?: number;
  /** The maximum screenshot base64 bytes (mirrors BrowserToolExecutor's bound). */
  readonly maxScreenshotBytes?: number;
}

/**
 * The Playwright-backed BrowserDriver. Implements the existing port (WORK-036)
 * — NO second browser abstraction. A SINGLE context + page is created lazily on
 * the first call and REUSED across subsequent calls (a real browser session:
 * navigate once, then interact with the loaded page). {@link close} tears the
 * session down. Tests construct a fresh driver per run (no state leakage across
 * runs); production would construct a fresh driver per validation run.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  private readonly browserOrFactory: PlaywrightBrowser | (() => Promise<PlaywrightBrowser>) | undefined;
  private readonly contextOptions: Parameters<PlaywrightBrowser['newContext']>[0];
  private readonly maxTextBytes: number;
  private readonly maxScreenshotBytes: number;
  private resolvedBrowser: PlaywrightBrowser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(options: PlaywrightBrowserDriverOptions = {}) {
    this.browserOrFactory = options.browser;
    this.contextOptions = options.contextOptions ?? {};
    this.maxTextBytes = options.maxTextBytes ?? 65_536;
    this.maxScreenshotBytes = options.maxScreenshotBytes ?? 262_144;
  }

  private async resolveBrowser(): Promise<PlaywrightBrowser> {
    if (this.browserOrFactory === undefined) {
      throw new Error('browser-driver-unavailable: no Playwright browser is configured');
    }
    if (this.resolvedBrowser === null) {
      this.resolvedBrowser =
        typeof this.browserOrFactory === 'function'
          ? await this.browserOrFactory()
          : this.browserOrFactory;
    }
    return this.resolvedBrowser;
  }

  /**
   * Lazily resolve + reuse the single context + page. A real browser session
   * navigates once and then interacts with the loaded page — the page state
   * persists across {@link open}/{@link click}/{@link type}/{@link extract}/
   * {@link screenshot} calls until {@link close} tears it down.
   */
  private async resolvePage(opts: BrowserDriverCallOptions): Promise<Page> {
    if (this.page === null) {
      const browser = await this.resolveBrowser();
      this.context = await browser.newContext(this.contextOptions);
      this.page = await this.context.newPage();
    }
    this.page.setDefaultTimeout(opts.timeoutMs);
    this.page.setDefaultNavigationTimeout(opts.timeoutMs);
    return this.page;
  }

  async open(url: string, opts: BrowserDriverCallOptions): Promise<BrowserNavigationResult> {
    // Defense in depth: validate the URL scheme + userinfo BEFORE creating a
    // page or calling page.goto(). The effect-policy enforcement gate is the
    // PRIMARY enforcement (it classifies non-http(s)/userinfo/query-string
    // targets and rejects them before the driver is called); this validation
    // is the driver's OWN backstop — the documented "http(s) URLs only"
    // guarantee made real. A bad URL that somehow reaches the driver throws
    // here without ever calling page.goto() (proven by the URL-validation test).
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`browser url is not parseable: ${JSON.stringify(url)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `browser url scheme '${parsed.protocol}' is not http(s) — the PlaywrightBrowserDriver rejects unsupported schemes before page.goto()`,
      );
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new Error(
        'browser url must not embed userinfo (username:password@) — the PlaywrightBrowserDriver rejects userinfo before page.goto()',
      );
    }
    const page = await this.resolvePage(opts);
    const response = await page.goto(url, { timeout: opts.timeoutMs, waitUntil: 'domcontentloaded' });
    const finalUrl = page.url();
    const status = response?.status() ?? null;
    const title = await page.title().catch(() => null);
    return { finalUrl, status, title };
  }

  async click(selector: string, opts: BrowserDriverCallOptions): Promise<BrowserActionResult> {
    const page = await this.resolvePage(opts);
    try {
      await page.click(selector, { timeout: opts.timeoutMs });
      return { matched: true, finalUrl: page.url() };
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || /timeout/i.test(e.message)) {
        return { matched: false, finalUrl: page.url() };
      }
      throw e;
    }
  }

  async type(selector: string, text: string, opts: BrowserDriverCallOptions): Promise<BrowserActionResult> {
    const page = await this.resolvePage(opts);
    try {
      await page.fill(selector, text, { timeout: opts.timeoutMs });
      return { matched: true, finalUrl: page.url() };
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || /timeout/i.test(e.message)) {
        return { matched: false, finalUrl: page.url() };
      }
      throw e;
    }
  }

  async extract(selector: string, opts: BrowserDriverCallOptions): Promise<BrowserExtractionResult> {
    const page = await this.resolvePage(opts);
    try {
      const handle = await page.waitForSelector(selector, { timeout: opts.timeoutMs, state: 'attached' });
      const rawText = (await handle.textContent()) ?? '';
      const truncated = Buffer.byteLength(rawText, 'utf8') > this.maxTextBytes;
      const text = truncated
        ? Buffer.from(rawText).subarray(0, this.maxTextBytes).toString('utf8')
        : rawText;
      return { matched: true, text, finalUrl: page.url() };
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || /timeout/i.test(e.message)) {
        return { matched: false, text: '', finalUrl: page.url() };
      }
      throw e;
    }
  }

  async screenshot(opts: BrowserDriverCallOptions): Promise<BrowserScreenshotResult> {
    const page = await this.resolvePage(opts);
    const buf = await page.screenshot({ type: 'png', timeout: opts.timeoutMs });
    const base64 = buf.toString('base64');
    const truncated = base64.length > this.maxScreenshotBytes;
    const truncatedBase64 = truncated ? base64.slice(0, this.maxScreenshotBytes) : base64;
    return { base64: truncatedBase64, finalUrl: page.url() };
  }

  /**
   * Close the persistent page + context + (if this driver launched it) the
   * underlying browser. Safe to call multiple times. Used by tests to clean
   * up after a real-browser run.
   */
  async close(): Promise<void> {
    await this.page?.close().catch(() => {
      // best-effort close
    });
    await this.context?.close().catch(() => {
      // best-effort close
    });
    this.page = null;
    this.context = null;
    if (
      this.browserOrFactory !== undefined &&
      typeof this.browserOrFactory === 'object' &&
      typeof (this.browserOrFactory as PlaywrightBrowser).close === 'function'
    ) {
      await (this.browserOrFactory as PlaywrightBrowser).close().catch(() => {
        // best-effort close
      });
    }
  }
}

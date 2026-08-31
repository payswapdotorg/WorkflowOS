import { describe, it, expect } from 'vitest';

/**
 * WORK-065 — the PlaywrightBrowserDriver URL-validation backstop (PR #97
 * architect review correction — REQUEST CHANGES).
 *
 * THE DEFECT: the driver documented "http(s) URLs only" but did not actually
 * enforce it — `open()` called `page.goto()` directly. The architect required:
 * "make the URL guarantee real in PlaywrightBrowserDriver, including rejecting
 * unsupported schemes rather than merely documenting them."
 *
 * THE FIX: `PlaywrightBrowserDriver.open()` validates the URL scheme + userinfo
 * BEFORE calling `this.resolvePage()` (which creates the context + page) and
 * `page.goto()`. A bad URL throws without ever reaching `page.goto()`.
 *
 * This is DEFENSE IN DEPTH: the effect-policy enforcement gate is the PRIMARY
 * enforcement (it classifies non-http(s)/userinfo/query-string targets and
 * rejects them before the driver is called — proven in agent-execution.test.ts
 * §14). This driver-level validation is the backstop — the documented "http(s)
 * URLs only" guarantee made real. If a bad URL somehow reaches the driver
 * (a gate bypass, a future wiring change), the driver itself throws.
 *
 * This test uses a SPY Playwright browser (no real Chromium launch) that
 * records every call to `newContext`/`newPage`/`goto`. For a bad URL, the spy
 * records ZERO calls — `page.goto()` is never reached.
 */
import { PlaywrightBrowserDriver } from '../../src/browser-validation/index.js';

// ---------------------------------------------------------------------------
// A spy Playwright browser that records every call (no real Chromium launch)
// ---------------------------------------------------------------------------

interface SpyCalls {
  readonly newContextCalls: number;
  readonly newPageCalls: number;
  readonly gotoCalls: readonly string[];
  readonly gotoShouldThrow: Error | null;
}

function makeSpyBrowser(): { browser: unknown; getCalls: () => SpyCalls } {
  const calls = {
    newContextCalls: 0,
    newPageCalls: 0,
    gotoCalls: [] as string[],
    gotoShouldThrow: null as Error | null,
  };
  const fakePage = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    url: () => 'https://example.com/',
    goto: async (target: string) => {
      calls.gotoCalls.push(target);
      if (calls.gotoShouldThrow) throw calls.gotoShouldThrow;
      return { status: () => 200 };
    },
    title: async () => 'Example',
    close: async () => {},
    click: async () => {},
    fill: async () => {},
    waitForSelector: async () => ({ textContent: async () => '' }),
    screenshot: async () => Buffer.alloc(0),
  };
  const fakeContext = {
    newPage: async () => {
      calls.newPageCalls++;
      return fakePage;
    },
    close: async () => {},
  };
  const fakeBrowser = {
    newContext: async () => {
      calls.newContextCalls++;
      return fakeContext;
    },
    close: async () => {},
  };
  return {
    browser: fakeBrowser,
    getCalls: () => ({
      newContextCalls: calls.newContextCalls,
      newPageCalls: calls.newPageCalls,
      gotoCalls: [...calls.gotoCalls],
      gotoShouldThrow: calls.gotoShouldThrow,
    }),
  };
}

// ---------------------------------------------------------------------------
// The URL-validation proofs
// ---------------------------------------------------------------------------

describe('WORK-065 PlaywrightBrowserDriver URL validation — the http(s)-only guarantee made real', () => {
  it('a valid http(s) URL → the driver calls page.goto() (the navigation executes)', async () => {
    const { browser, getCalls } = makeSpyBrowser();
    const driver = new PlaywrightBrowserDriver({ browser: browser as never });
    const result = await driver.open('https://example.com/sign-in', { timeoutMs: 5000 });
    expect(result.status).toBe(200);
    const calls = getCalls();
    expect(calls.newContextCalls).toBe(1);
    expect(calls.newPageCalls).toBe(1);
    expect(calls.gotoCalls).toEqual(['https://example.com/sign-in']);
  });

  it('a file: URL → the driver throws BEFORE page.goto() (goto never called, no context/page created)', async () => {
    const { browser, getCalls } = makeSpyBrowser();
    const driver = new PlaywrightBrowserDriver({ browser: browser as never });
    await expect(driver.open('file:///etc/passwd', { timeoutMs: 5000 })).rejects.toThrow(/not http\(s\)/);
    const calls = getCalls();
    // CRITICAL PROOF: the driver NEVER created a context/page and NEVER called
    // page.goto() for the forbidden scheme:
    expect(calls.newContextCalls).toBe(0);
    expect(calls.newPageCalls).toBe(0);
    expect(calls.gotoCalls).toEqual([]);
  });

  it('a data: URL → rejected before page.goto()', async () => {
    const { browser, getCalls } = makeSpyBrowser();
    const driver = new PlaywrightBrowserDriver({ browser: browser as never });
    await expect(driver.open('data:text/html,<h1>hi</h1>', { timeoutMs: 5000 })).rejects.toThrow(/not http\(s\)/);
    expect(getCalls().gotoCalls).toEqual([]);
  });

  it('a javascript: URL → rejected before page.goto()', async () => {
    const { browser, getCalls } = makeSpyBrowser();
    const driver = new PlaywrightBrowserDriver({ browser: browser as never });
    await expect(driver.open('javascript:void(0)', { timeoutMs: 5000 })).rejects.toThrow(/not http\(s\)/);
    expect(getCalls().gotoCalls).toEqual([]);
  });

  it('an about: URL → rejected before page.goto()', async () => {
    const { browser, getCalls } = makeSpyBrowser();
    const driver = new PlaywrightBrowserDriver({ browser: browser as never });
    await expect(driver.open('about:blank', { timeoutMs: 5000 })).rejects.toThrow(/not http\(s\)/);
    expect(getCalls().gotoCalls).toEqual([]);
  });

  it('a URL with embedded userinfo → rejected before page.goto()', async () => {
    const { browser, getCalls } = makeSpyBrowser();
    const driver = new PlaywrightBrowserDriver({ browser: browser as never });
    await expect(driver.open('https://user:pass@example.com/sign-in', { timeoutMs: 5000 })).rejects.toThrow(/userinfo/);
    const calls = getCalls();
    expect(calls.newContextCalls).toBe(0);
    expect(calls.newPageCalls).toBe(0);
    expect(calls.gotoCalls).toEqual([]);
  });

  it('an unparseable URL → rejected before page.goto()', async () => {
    const { browser, getCalls } = makeSpyBrowser();
    const driver = new PlaywrightBrowserDriver({ browser: browser as never });
    await expect(driver.open('not-a-url', { timeoutMs: 5000 })).rejects.toThrow(/not parseable/);
    expect(getCalls().gotoCalls).toEqual([]);
  });

  it('http (not just https) is accepted', async () => {
    const { browser, getCalls } = makeSpyBrowser();
    const driver = new PlaywrightBrowserDriver({ browser: browser as never });
    await driver.open('http://127.0.0.1:5173/sign-in', { timeoutMs: 5000 });
    expect(getCalls().gotoCalls).toEqual(['http://127.0.0.1:5173/sign-in']);
  });
});

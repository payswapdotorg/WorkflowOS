/**
 * WORK-022 — Manual DOM setup for rendered-UI tests.
 *
 * Vitest's `@vitest-environment jsdom` transforms `import.meta.url` for
 * every module the test imports, which breaks backend modules that use
 * `fileURLToPath(new URL('./...', import.meta.url))` to locate files on
 * disk (the migration runner, the object store, etc.).
 *
 * To avoid that, we run the rendered-UI tests in the default `node`
 * environment and set up the DOM globals (window, document, navigator) that
 * @testing-library/react needs by hand. This keeps `import.meta.url` working
 * for backend modules while still letting us mount real React components.
 */
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

let dom: JSDOM | null = null;

// Some `globalThis` properties (navigator, performance) are read-only
// getters in modern Node.js. Use defineProperty to override them.
function setGlobal(key: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  } catch {
    // Fallback: direct assignment for already-writable properties.
    (globalThis as Record<string, unknown>)[key] = value;
  }
}

beforeAll(() => {
  dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });

  const { window } = dom;

  setGlobal('window', window);
  setGlobal('document', window.document);
  setGlobal('navigator', window.navigator);
  setGlobal('HTMLElement', window.HTMLElement);
  setGlobal('Node', window.Node);
  setGlobal('Element', window.Element);
  setGlobal('getComputedStyle', window.getComputedStyle);
  setGlobal('Event', window.Event);
  setGlobal('CustomEvent', window.CustomEvent);
  setGlobal('MutationObserver', window.MutationObserver);
  setGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  setGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  // jsdom provides localStorage + sessionStorage + location on the window.
  // (fetch / Response / Headers / Request / URL stay as Node's natives —
  // they're more robust than jsdom's and the test stubs fetch anyway.)
  setGlobal('localStorage', window.localStorage);
  setGlobal('sessionStorage', window.sessionStorage);
  setGlobal('location', window.location);
  setGlobal('history', window.history);

  // matchMedia + scrollTo polyfills (jsdom doesn't implement them).
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  if (typeof window.scrollTo !== 'function') {
    Object.defineProperty(window, 'scrollTo', {
      writable: true,
      configurable: true,
      value: () => {},
    });
  }

  // React Testing Library reads `window.IS_REACT_ACT_ENVIRONMENT`.
  (window as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  // Clean up the DOM between tests so render() starts from a blank body.
  cleanup();
  if (dom) {
    const root = dom.window.document.getElementById('root');
    if (root) root.innerHTML = '';
  }
});

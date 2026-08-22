/**
 * WORK-022 frontend test setup.
 *
 * Wires @testing-library/jest-dom matchers and polyfills the jsdom
 * environment so React pages that use `fetch`, `URL`, `crypto.randomUUID`,
 * and `window.matchMedia` can mount cleanly.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library auto-cleanup between tests.
afterEach(() => {
  cleanup();
});

// jsdom lacks a native fetch in older versions; Node's global fetch covers it.
// We also polyfill the bits of the Web platform that React 18 + react-router 6
// touch during initial mount.
beforeAll(() => {
  // jsdom does not implement matchMedia; react-router/@testing-library may
  // touch it during mount. Polyfill with a no-op implementation.
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
  // Silence React Router v6 future-flag warnings during tests.
  vi.stubEnv('NODE_ENV', 'test');
});

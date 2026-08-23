/**
 * Minimal chrome.* API mocks for extension unit tests. Asserts the token
 * non-persistence invariant (no localStorage, no storage.local writes).
 */
export function createChromeMock() {
  const sessionArea = new Map<string, string>();
  const localStorageSpy = { setItem: vi.fn(), getItem: vi.fn() };

  const listeners: Array<(msg: unknown, sender: unknown, respond: (r: unknown) => void) => unknown> =
    [];

  const chromeMock = {
    runtime: {
      id: 'test-extension-id',
      onMessage: {
        addListener(
          listener: (msg: unknown, sender: unknown, respond: (r: unknown) => void) => unknown,
        ) {
          listeners.push(listener);
        },
      },
      sendMessage: vi.fn(async () => null),
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    },
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => {
        const tabId = Math.floor(1000 + Math.random() * 9000);
        chromeMock.tabs.opened.push({ id: tabId, url });
        return { id: tabId };
      }),
      remove: vi.fn(async () => undefined),
      opened: [] as { id: number; url: string }[],
    },
    storage: {
      session: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (sessionArea.has(k)) out[k] = sessionArea.get(k);
          return out;
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) sessionArea.set(k, v as string);
        },
        async remove(keys: string[]) {
          for (const k of keys) sessionArea.delete(k);
        },
      },
    },
  };

  /** Dispatch a message as if sent via chrome.runtime.sendMessage. */
  async function dispatch(msg: unknown): Promise<unknown> {
    let response: unknown;
    let responded = false;
    const respond = (r: unknown) => {
      responded = true;
      response = r;
    };
    for (const listener of listeners) {
      const result = listener(msg, {}, respond);
      if (result === true) {
        // async response — poll briefly
        for (let i = 0; i < 100 && !responded; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
      }
    }
    return response;
  }

  return { chromeMock, sessionArea, localStorageSpy, dispatch };
}

/** Install the mock on globalThis for modules that read globalThis.chrome. */
export function installChrome(chromeMock: unknown) {
  (globalThis as { chrome?: unknown }).chrome = chromeMock;
}

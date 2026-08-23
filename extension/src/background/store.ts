/**
 * WorkflowOS Companion — background service worker state store.
 *
 * Sessions + the reporter queue live in chrome.storage.session (MEMORY-BACKED:
 * survives service-worker restarts within one browser session, cleared when
 * the browser closes). Callback tokens are NEVER written to localStorage or
 * the disk-synced chrome.storage.local (statically enforced).
 */

// ---- storage.session wrapper (injectable for tests) ----

export interface SessionStorageArea {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export function chromeSessionStorage(area: SessionStorageArea) {
  return {
    async getJson<T>(key: string): Promise<T | null> {
      const raw = (await area.get([key]))[key];
      if (typeof raw !== 'string') return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async setJson(key: string, value: unknown): Promise<void> {
      await area.set({ [key]: JSON.stringify(value) });
    },
    async remove(key: string): Promise<void> {
      await area.remove([key]);
    },
  };
}

import { useState, useCallback, useEffect } from 'react';
import { auth } from '../api/client';

/**
 * WORK-022 auth hook.
 *
 * The browser never decides whether a user is authorized — the backend does.
 * This hook only remembers whether an API key has been entered locally and
 * sends it with each request. A 401/403 from the backend is the authority.
 */
export function useAuth() {
  const [hasApiKey, setHasApiKey] = useState<boolean>(auth.hasApiKey());

  const setApiKey = useCallback((key: string) => {
    auth.setApiKey(key);
    setHasApiKey(true);
  }, []);

  const clearApiKey = useCallback(() => {
    auth.clearApiKey();
    setHasApiKey(false);
  }, []);

  return { hasApiKey, setApiKey, clearApiKey };
}

/**
 * Generic data-fetching hook.
 *
 * Frontend state is ALWAYS derived from backend/API responses. This hook never
 * owns authoritative state — it just caches the most recent backend response
 * for UX, and exposes loading/error/empty states.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      setData(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}

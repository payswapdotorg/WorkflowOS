import { useState, useCallback, useEffect } from 'react';
import { auth } from '../api/client';

export function useAuth() {
  const [hasApiKey, setHasApiKey] = useState(auth.hasApiKey());

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

// Generic data fetching hook
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

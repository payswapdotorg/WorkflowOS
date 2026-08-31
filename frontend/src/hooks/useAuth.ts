import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { auth, type AuthState, type SessionUser, type LoginProviderInfo } from '../api/client';

/**
 * WORK-022 / WORK-074 auth hook.
 *
 * The browser never decides whether a user is authorized — the backend does.
 * This hook reads from the ONE canonical auth-state source (the observable
 * auth client): there is NO per-instance auth state anymore. When the source
 * changes (sign-in, logout, a backend 401), EVERY consumer — including the
 * App shell — re-renders synchronously with the new state, so a successful
 * sign-in makes the protected routes visible WITHOUT a manual reload
 * (the WORK-074 dogfooding-gate precondition; the WORK-072 state-ownership
 * pattern this login surface also uses).
 */
export function useAuth(): {
  status: AuthState['status'];
  user: SessionUser | null;
  refreshSession: () => void;
  loginWithPassword: (email: string, password: string) => Promise<SessionUser>;
  registerWithPassword: (email: string, password: string, displayName?: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
} {
  const snapshot = useSyncExternalStore(auth.subscribe, auth.getSnapshot);

  const refreshSession = useCallback(() => {
    void auth.fetchSession();
  }, []);

  return {
    status: snapshot.status,
    user: snapshot.user,
    refreshSession,
    loginWithPassword: (email, password) => auth.loginWithPassword(email, password),
    registerWithPassword: (email, password, displayName) =>
      auth.registerWithPassword(email, password, displayName),
    logout: () => auth.logout(),
  };
}

/**
 * The human login providers configured on the backend (honest states only —
 * an unconfigured provider renders as unavailable, never as a working
 * surface). Reads go straight through the auth client; this hook caches only
 * the PROVIDER LIST response, never auth state.
 */
export function useLoginProviders(enabled: boolean): {
  providers: LoginProviderInfo[] | null;
  error: string | null;
} {
  const [providers, setProviders] = useState<LoginProviderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    auth
      .fetchProviders()
      .then((list) => {
        if (!cancelled) {
          setProviders(list);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { providers, error };
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

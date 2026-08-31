import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth, useLoginProviders } from '@/hooks/useAuth';
import { auth } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GitHubLogoIcon } from '@/components/icons/GitHubLogoIcon';
import { GoogleLogoIcon } from '@/components/icons/GoogleLogoIcon';

/**
 * WORK-074 — the human login surface (the WORK-063 providers: Google, GitHub,
 * email/password). The demo-key API-key input is RETIRED from the
 * customer-facing production login path (WORK-063 invariant #9).
 *
 * The browser never decides authorization: signing in calls the backend and
 * the canonical auth-state source updates from the backend's response. On
 * success the App shell re-renders synchronously — NO manual reload.
 */
export default function LoginPage() {
  const { status, loginWithPassword, registerWithPassword } = useAuth();
  const { providers, error: providersError } = useLoginProviders(true);
  const navigate = useNavigate();
  const location = useLocation();

  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Surface OAuth callback errors (/?login_error=…) honestly.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const loginError = params.get('login_error');
    if (loginError) {
      const messages: Record<string, string> = {
        invalid_state: 'The sign-in attempt expired. Please try again.',
        email_conflict:
          'This email already belongs to an account that signs in with another method. Use your original sign-in method.',
        provider_exchange_failed: 'The provider could not confirm the sign-in. Please try again.',
        provider_not_configured: 'That sign-in provider is not configured on this deployment.',
      };
      setError(messages[loginError] ?? 'Sign-in failed. Please try again.');
      // Clean the query so a reload does not resurrect the error.
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [location.key]);

  const redirectTo = '/';

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Email and password are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (mode === 'signin') {
        await loginWithPassword(email.trim(), password);
      } else {
        await registerWithPassword(email.trim(), password, displayName.trim() || undefined);
      }
      // The canonical auth state is now authenticated; the App shell shows the
      // protected routes synchronously (no reload).
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleProviderLogin = async (provider: 'google' | 'github') => {
    setError(null);
    try {
      const url = await auth.startOAuth(provider, redirectTo);
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Still resolving the session from the backend (avoids flashing the form).
  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="flex flex-col items-center gap-3">
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"
            role="status"
            aria-label="Loading"
          />
          <p className="text-sm text-muted-foreground">Checking your session…</p>
        </div>
      </div>
    );
  }

  const google = providers?.find((p) => p.id === 'google');
  const github = providers?.find((p) => p.id === 'github');

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="flex items-center justify-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <span className="font-bold">W</span>
            </div>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">WorkflowOS</h1>
          <p className="text-sm text-muted-foreground">
            Build reliable software from architecture to verified implementation.
          </p>
        </div>

        {/* Human login providers (WORK-063). Only CONFIGURED providers are
            actionable; unconfigured ones render as unavailable (honest state). */}
        <div className="space-y-2">
          <ProviderButton
            label="Continue with Google"
            enabled={google?.configured === true}
            onClick={() => handleProviderLogin('google')}
          >
            <GoogleLogoIcon className="h-4 w-4" />
          </ProviderButton>
          <ProviderButton
            label="Continue with GitHub"
            enabled={github?.configured === true}
            onClick={() => handleProviderLogin('github')}
          >
            <GitHubLogoIcon className="h-4 w-4" />
          </ProviderButton>
          {(google?.configured === false || github?.configured === false) && (
            <p className="text-center text-xs text-muted-foreground">
              A provider marked unavailable is not configured on this deployment.
            </p>
          )}
          {providersError && (
            <p className="text-center text-xs text-destructive">Could not load sign-in providers.</p>
          )}
        </div>

        <div className="flex items-center gap-3" role="separator" aria-label="or">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs uppercase tracking-wide text-muted-foreground">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          {mode === 'register' && (
            <div className="space-y-2">
              <Label htmlFor="displayName">Name</Label>
              <Input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Ada Lovelace"
                disabled={loading}
                autoComplete="name"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={loading}
              autoFocus
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
              disabled={loading}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <button
            type="button"
            className="underline underline-offset-4 hover:text-foreground"
            onClick={() => {
              setMode(mode === 'signin' ? 'register' : 'signin');
              setError(null);
            }}
          >
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </p>

        <p className="text-center text-xs text-muted-foreground">
          The backend retains all authoritative state.
        </p>
      </div>
    </div>
  );
}

function ProviderButton({
  label,
  enabled,
  onClick,
  children,
}: {
  label: string;
  enabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      disabled={!enabled}
      onClick={onClick}
      aria-disabled={!enabled}
      title={enabled ? undefined : 'Not configured on this deployment'}
    >
      {children}
      <span className="ml-2">{enabled ? label : `${label} (unavailable)`}</span>
    </Button>
  );
}

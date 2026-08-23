import * as React from 'react';
import { Link } from 'react-router-dom';
import { Bot, Sparkles, Rocket, Cloud } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/domain/loading-state';
import { agentProviders } from '@/api/client';

/**
 * WORK-026: Provider Settings page.
 *
 * Shows readiness for Architect, Implementation Agent, GitHub, and Vercel
 * providers. NEVER shows secrets — only readiness status (Connected /
 * Not configured / Error / Test mode). Secrets are managed via env vars
 * / SecretStore on the backend, never through this UI.
 */
export default function ProviderSettingsPage() {
  const [agentProviderList, setAgentProviderList] = React.useState<Array<{ name: string; provider: string; model: string; status: string }>>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await agentProviders.listGlobal();
        if (cancelled) return;
        setAgentProviderList(list);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <LoadingState />;
  if (error) {
    return (
      <Card>
        <CardContent>
          <p className="text-red-600">Failed to load providers: {error}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Provider Settings</h1>
        <p className="text-muted-foreground">
          Readiness for each integration. Secrets are managed via server-side environment variables — never through this UI.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              <CardTitle>Implementation Agent</CardTitle>
            </div>
            <CardDescription>LLM provider for code implementation</CardDescription>
          </CardHeader>
          <CardContent>
            {agentProviderList.length === 0 ? (
              <p className="text-sm text-muted-foreground">No providers configured.</p>
            ) : (
              <ul className="space-y-1">
                {agentProviderList.map((p, i) => (
                  <li key={i} className="text-sm flex items-center justify-between">
                    <span>{p.provider} / {p.model}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${p.status === 'ready' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                      {p.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              <CardTitle>Architect</CardTitle>
            </div>
            <CardDescription>LLM provider for architecture generation</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Architect provider readiness is configured per-project. Visit a project's Integrations page to check status.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Rocket className="h-5 w-5" />
              <CardTitle>GitHub</CardTitle>
            </div>
            <CardDescription>Repository provisioning + PR boundary</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              GitHub readiness is configured per-project. Visit a project's Integrations page to check status.
            </p>
            <Link to="/" className="text-sm text-primary hover:underline mt-2 inline-block">
              ← Back to projects
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Cloud className="h-5 w-5" />
              <CardTitle>Vercel</CardTitle>
            </div>
            <CardDescription>Preview deployment provider</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Vercel readiness is configured per-project. Visit a project's Integrations page to check status.
            </p>
            <Link to="/" className="text-sm text-primary hover:underline mt-2 inline-block">
              ← Back to projects
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

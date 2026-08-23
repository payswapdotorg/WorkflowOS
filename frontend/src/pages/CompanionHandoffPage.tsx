import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { execution, type ExecutionSummary } from '@/api/client';

/**
 * WORK-028 §19/§20: the Companion handoff page.
 *
 * The SPA navigates here (fragment-only deep link) when the user clicks
 * "Open with Companion":
 *
 *   /companion/handoff#ref=<one-time-opaque-ref>&exec=<executionId>
 *
 * The fragment is never sent to the server. The Companion extension's
 * content script picks the ref up and redeems it directly with WorkflowOS.
 * This page:
 *   - answers "is the extension installed?" via a DOM ping/pong handshake;
 *   - shows "WorkflowOS Companion not installed" + help when absent;
 *   - shows the companion status when present (the extension reports back
 *     through a DOM status event);
 *   - polls the execution status (the page user is API-key authenticated) so
 *     the user sees Running / Completed as events arrive.
 */
type CompanionPresence = 'checking' | 'installed' | 'not-installed';

interface HandoffStatus {
  ok?: boolean;
  executionId?: string;
  provider?: string;
  error?: string;
}

export default function CompanionHandoffPage() {
  const location = useLocation();
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const ref = params.get('ref');
  const execId = params.get('exec') ?? null;

  const [presence, setPresence] = useState<CompanionPresence>('checking');
  const [handoffStatus, setHandoffStatus] = useState<HandoffStatus | null>(null);
  const [executionSummary, setExecutionSummary] = useState<ExecutionSummary | null>(null);

  // --- install handshake: ping until pong (or timeout → not installed). ---
  useEffect(() => {
    let ponged = false;
    const onPong = () => {
      ponged = true;
      setPresence('installed');
    };
    const onStatus = (event: Event) => {
      const detail = (event as CustomEvent<HandoffStatus>).detail;
      if (detail && typeof detail === 'object') setHandoffStatus(detail);
    };
    window.addEventListener('workflowos:companion-pong', onPong);
    window.addEventListener('workflowos:companion-status', onStatus);

    let attempts = 0;
    const ping = setInterval(() => {
      // Also honor the content script's document marker.
      const marker = document.documentElement.getAttribute('data-workflowos-companion');
      if (marker) {
        onPong();
        clearInterval(ping);
        return;
      }
      window.dispatchEvent(new CustomEvent('workflowos:companion-ping'));
      attempts += 1;
      if (ponged) {
        clearInterval(ping);
      } else if (attempts >= 5) {
        clearInterval(ping);
        setPresence('not-installed');
      }
    }, 400);
    // Fire one immediately.
    window.dispatchEvent(new CustomEvent('workflowos:companion-ping'));

    return () => {
      clearInterval(ping);
      window.removeEventListener('workflowos:companion-pong', onPong);
      window.removeEventListener('workflowos:companion-status', onStatus);
    };
  }, []);

  // --- execution status polling (user is authenticated; API-key path). ---
  useEffect(() => {
    if (!execId) return;
    let alive = true;
    const poll = async () => {
      const summary = await execution.get(execId).catch(() => null);
      if (alive && summary) setExecutionSummary(summary);
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [execId]);

  // The extension acks the handoff via the DOM status event; surface errors.
  const handoffError = handoffStatus && handoffStatus.ok === false ? handoffStatus.error : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">External Execution — Companion Handoff</h1>
        {presence === 'installed' && <Badge variant="default">Companion connected</Badge>}
        {presence === 'not-installed' && <Badge variant="destructive">Companion not installed</Badge>}
        {presence === 'checking' && <Badge variant="secondary">Checking for Companion…</Badge>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Execution</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {execId ? (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-xs text-muted-foreground">Execution</span>
                <p className="font-mono text-xs">{execId}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Status</span>
                <p className="font-medium">{executionSummary?.status ?? '—'}</p>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">
              No execution reference in this handoff link.
            </p>
          )}
          {executionSummary && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-xs text-muted-foreground">Provider</span>
                <p className="font-medium">{executionSummary.provider}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Branch</span>
                <p className="font-mono text-xs">{executionSummary.branch ?? '—'}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {presence === 'not-installed' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">WorkflowOS Companion not installed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              This handoff link is consumed by the WorkflowOS Companion browser
              extension. Install the Companion (Chromium, Manifest V3), reload
              this page, and the external session opens automatically — no
              copy/paste.
            </p>
            <ol className="ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
              <li>Clone the WorkflowOS repository.</li>
              <li>
                Build the extension:{' '}
                <code className="rounded bg-muted px-1">cd extension &amp;&amp; bun install &amp;&amp; bun run build</code>
              </li>
              <li>
                Visit <code className="rounded bg-muted px-1">chrome://extensions</code>, enable
                Developer mode, and “Load unpacked” the{' '}
                <code className="rounded bg-muted px-1">extension/dist</code> directory.
              </li>
            </ol>
            <a
              className="text-sm underline"
              href="https://github.com/pectoraux/WorkflowOS/tree/main/extension#readme"
              target="_blank"
              rel="noreferrer"
            >
              Companion installation &amp; security guide
            </a>
          </CardContent>
        </Card>
      )}

      {presence === 'installed' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Companion session</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {handoffError ? (
              <p className="text-destructive">Companion reported an error: {handoffError}</p>
            ) : handoffStatus?.ok ? (
              <p>
                Session opened with provider <strong>{handoffStatus.provider}</strong>. The
                external session is running in a Companion-managed tab; execution events
                flow back to WorkflowOS automatically.
              </p>
            ) : (
              <p className="text-muted-foreground">
                Waiting for the Companion to redeem the handoff…
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {!ref && (
        <p className="text-sm text-muted-foreground">
          This page has no handoff reference — start an external execution and
          choose “Open with Companion”.
        </p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" asChild>
          <Link to="/">Back to projects</Link>
        </Button>
      </div>
    </div>
  );
}

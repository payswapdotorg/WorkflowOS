import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { audit, type AuditEvent, ApiError } from '@/api/client';
import { Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
export default function ActivityPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    audit.listForProject(projectId)
      .then(setEvents)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load activity'))
      .finally(() => setLoading(false));
  }, [projectId]);
  if (loading) return <LoadingState label="Loading activity…" />;
  if (error) return <ErrorState message={error} />;
  return (
    <div className="space-y-6">
      <div><h1 className="text-xl font-semibold">Activity</h1><p className="text-sm text-muted-foreground">Audit trail and event history</p></div>
      {events.length === 0 ? (
        <Card><CardContent className="py-12"><EmptyState title="No activity yet" description="Actions taken in this project will appear here." /></CardContent></Card>
      ) : (
        <Card><CardContent className="pt-6">
          <div className="space-y-3">
            {events.map((e) => (
              <div key={e.id} className="flex items-start gap-3 border-b pb-3 last:border-0">
                <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-muted">
                  <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">{e.eventType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</p>
                  <p className="text-xs text-muted-foreground">
                    {e.actor} · {e.source} · {e.resourceType}
                    {e.executionId && <span className="font-mono"> · exec:{e.executionId.slice(0, 8)}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent></Card>
      )}
    </div>
  );
}

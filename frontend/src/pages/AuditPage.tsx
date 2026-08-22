import { useParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import {
  audit, type AuditEvent, ApiError,
} from '../api/client';

export default function AuditPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    audit.listForProject(projectId)
      .then(setEvents)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load audit history'))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <div>Loading audit history...</div>;
  if (error) return <div style={{ color: 'red' }}>Error: {error}</div>;

  return (
    <div>
      <h1>Audit History</h1>
      {events.length === 0 ? <p>No audit events found.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
            <th style={{ padding: 5 }}>Event Type</th>
            <th style={{ padding: 5 }}>Actor</th>
            <th style={{ padding: 5 }}>Source</th>
            <th style={{ padding: 5 }}>Resource</th>
            <th style={{ padding: 5 }}>Execution ID</th>
            <th style={{ padding: 5 }}>Timestamp</th>
          </tr></thead>
          <tbody>
            {events.map(e => (
              <tr key={e.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 5 }}>{e.eventType}</td>
                <td style={{ padding: 5 }}>{e.actor}</td>
                <td style={{ padding: 5 }}>{e.source}</td>
                <td style={{ padding: 5 }}>{e.resourceType}/{e.resourceId.slice(0, 8)}...</td>
                <td style={{ padding: 5 }}>{e.executionId?.slice(0, 8) || '-'}</td>
                <td style={{ padding: 5 }}>{new Date(e.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

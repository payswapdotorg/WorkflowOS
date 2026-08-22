import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Minimal project landing page.
 *
 * The backend does not expose a "list projects for current user" endpoint, so
 * the UI offers a simple input: the user enters a project ID and is routed to
 * `/projects/:projectId`. The backend authoritatively decides whether the user
 * may view that project (401/403/404 handling lives in the page components).
 */
export default function ProjectListPage() {
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = projectId.trim();
    if (!trimmed) return;
    navigate(`/projects/${trimmed}`);
  };

  return (
    <div>
      <h1>Projects</h1>
      <p>Enter a project ID to view its authoritative state.</p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, maxWidth: 600 }}>
        <input
          type="text"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="Project ID (UUID)"
          style={{ flex: 1, padding: 8 }}
          aria-label="Project ID"
        />
        <button type="submit" style={{ padding: '8px 16px' }}>Open</button>
      </form>
    </div>
  );
}

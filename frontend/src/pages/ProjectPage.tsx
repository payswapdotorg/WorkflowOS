import { useParams, Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { projects, architecture, requirements, type Project, type Architecture, type ArchitectureVersion, type Requirement, type AcceptanceCriterion, ApiError } from '../api/client';

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [architectures, setArchitectures] = useState<Architecture[]>([]);
  const [versions, setVersions] = useState<ArchitectureVersion[]>([]);
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [criteria, setCriteria] = useState<Record<string, AcceptanceCriterion[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      projects.get(projectId),
      architecture.listForProject(projectId),
    ]).then(async ([proj, archs]) => {
      setProject(proj);
      setArchitectures(archs);
      if (archs.length > 0) {
        const vs = await architecture.listVersions(archs[0].id);
        setVersions(vs);
        if (vs.length > 0) {
          const rs = await requirements.listForVersion(vs[0].id);
          setReqs(rs);
          const critMap: Record<string, AcceptanceCriterion[]> = {};
          for (const r of rs) {
            critMap[r.id] = await requirements.listCriteria(r.id);
          }
          setCriteria(critMap);
        }
      }
    }).catch((err) => {
      setError(err instanceof ApiError ? err.message : 'Failed to load project');
    }).finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <div>Loading project...</div>;
  if (error) return <div style={{ color: 'red' }}>Error: {error}</div>;
  if (!project) return <div>Project not found</div>;

  return (
    <div>
      <h1>{project.name}</h1>
      <p><strong>ID:</strong> {project.id}</p>
      <p><strong>State:</strong> {project.state}</p>
      <p><strong>Organization:</strong> {project.organizationId}</p>

      <h2>Architecture</h2>
      {architectures.map((arch) => (
        <div key={arch.id} style={{ marginBottom: 10, padding: 10, border: '1px solid #ddd' }}>
          <strong>{arch.name}</strong> (ID: {arch.id})
          {versions.filter(v => v.architectureId === arch.id).map(v => (
            <div key={v.id} style={{ marginLeft: 20 }}>
              Version: {v.id.slice(0, 8)}... -- State: <strong>{v.state}</strong>
            </div>
          ))}
        </div>
      ))}

      <h2>Requirements</h2>
      {reqs.length === 0 ? <p>No requirements found.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
              <th style={{ padding: 5 }}>ID</th>
              <th style={{ padding: 5 }}>Title</th>
              <th style={{ padding: 5 }}>Status</th>
              <th style={{ padding: 5 }}>Criteria</th>
            </tr>
          </thead>
          <tbody>
            {reqs.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 5 }}>{r.requirementId}</td>
                <td style={{ padding: 5 }}>{r.title}</td>
                <td style={{ padding: 5 }}>{r.status}</td>
                <td style={{ padding: 5 }}>
                  {(criteria[r.id] || []).map(c => (
                    <div key={c.id}>{c.criterionId}: {c.description} ({c.status})</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Work Items</h2>
      <p>Work items are displayed on the work item page. Use the workflow API to list them.</p>

      <div style={{ marginTop: 20 }}>
        <Link to={`/projects/${project.id}/audit`}>View Audit History</Link>
      </div>
    </div>
  );
}

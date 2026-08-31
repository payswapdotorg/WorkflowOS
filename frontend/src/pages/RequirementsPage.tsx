import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/domain/status-badge';
import { architecture, requirements, type Requirement, type AcceptanceCriterion } from '@/api/client';
import { Plus, ArrowRight } from 'lucide-react';
export default function RequirementsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [criteria, setCriteria] = useState<Record<string, AcceptanceCriterion[]>>({});
  const [versionId, setVersionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      setLoading(true);
      try {
        const archs = await architecture.listForProject(projectId);
        if (archs.length === 0) { setLoading(false); return; }
        const vs = await architecture.listVersions(archs[0].id);
        const frozen = vs.find(v => v.state === 'frozen') ?? vs[0];
        if (!frozen) { setLoading(false); return; }
        setVersionId(frozen.id);
        const rs = await requirements.listForVersion(frozen.id);
        setReqs(rs);
        const cs: Record<string, AcceptanceCriterion[]> = {};
        for (const r of rs) cs[r.id] = await requirements.listCriteria(r.id);
        setCriteria(cs);
      } catch (err) { setError((err as Error).message); }
      finally { setLoading(false); }
    })();
  }, [projectId]);
  if (loading) return <LoadingState label="Loading requirements…" />;
  if (error) return <ErrorState message={error} />;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-semibold">Requirements</h1><p className="text-sm text-muted-foreground">Manage requirements and acceptance criteria</p></div>
        {versionId && <CreateRequirementForm versionId={versionId} onCreated={() => window.location.reload()} />}
      </div>
      {reqs.length === 0 ? (
        <Card><CardContent className="py-12"><EmptyState title="No requirements yet" description="Add a requirement to start defining acceptance criteria." /></CardContent></Card>
      ) : (
        <div className="space-y-4">
          {reqs.map((req) => (
            <Card key={req.id}>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base">
                <span className="font-mono text-xs text-muted-foreground">{req.requirementId}</span>
                {req.title}
              </CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {(criteria[req.id] ?? []).map((crit) => (
                    <div key={crit.id} className="flex items-center justify-between rounded-md border p-3">
                      <div className="flex items-center gap-3">
                        <StatusBadge value={crit.status} />
                        <div>
                          <p className="text-sm font-medium">{crit.criterionId}</p>
                          <p className="text-xs text-muted-foreground">{crit.description}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                  <CreateCriterionForm requirementId={req.id} onCreated={() => window.location.reload()} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Work Item CTA — only when requirements exist */}
      {reqs.length > 0 && projectId && (
        <div className="flex justify-end border-t pt-4">
          <Button onClick={() => navigate(`/projects/${projectId}/work-items`)}>
            Create Work Item
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
function CreateRequirementForm({ versionId, onCreated }: { versionId: string; onCreated: () => void }) {
  const [show, setShow] = useState(false);
  const [reqId, setReqId] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reqId.trim() || !title.trim()) return;
    setLoading(true);
    try {
      await fetch('/api/architecture-versions/' + versionId + '/requirements', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ requirementId: reqId.trim(), title: title.trim() }),
      });
      onCreated();
    } finally { setLoading(false); }
  };
  if (!show) return <Button variant="outline" size="sm" onClick={() => setShow(true)}><Plus className="mr-1 h-4 w-4" />Add Requirement</Button>;
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <div className="space-y-1"><Label htmlFor="req-id">ID</Label><Input id="req-id" value={reqId} onChange={(e) => setReqId(e.target.value)} placeholder="REQ-001" className="w-24" /></div>
      <div className="flex-1 space-y-1"><Label htmlFor="req-title">Title</Label><Input id="req-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Authentication works" /></div>
      <Button type="submit" size="sm" disabled={loading}>{loading ? '…' : 'Add'}</Button>
    </form>
  );
}
function CreateCriterionForm({ requirementId, onCreated }: { requirementId: string; onCreated: () => void }) {
  const [show, setShow] = useState(false);
  const [critId, setCritId] = useState('');
  const [desc, setDesc] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!critId.trim() || !desc.trim()) return;
    setLoading(true);
    try {
      await fetch('/api/requirements/' + requirementId + '/criteria', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ criterionId: critId.trim(), description: desc.trim() }),
      });
      onCreated();
    } finally { setLoading(false); }
  };
  if (!show) return <Button variant="ghost" size="sm" onClick={() => setShow(true)}><Plus className="mr-1 h-3.5 w-3.5" />Add Criterion</Button>;
  return (
    <form onSubmit={submit} className="flex items-end gap-2 mt-2">
      <div className="space-y-1"><Label htmlFor="crit-id">ID</Label><Input id="crit-id" value={critId} onChange={(e) => setCritId(e.target.value)} placeholder="AC-001" className="w-24" /></div>
      <div className="flex-1 space-y-1"><Label htmlFor="crit-desc">Description</Label><Input id="crit-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Valid auth resolves identity" /></div>
      <Button type="submit" size="sm" disabled={loading}>{loading ? '…' : 'Add'}</Button>
    </form>
  );
}

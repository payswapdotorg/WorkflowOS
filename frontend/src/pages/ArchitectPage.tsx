import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Send, Check, Snowflake, Sparkles, GitCompare } from 'lucide-react';
import {
  architect,
  type ArchitectProvider,
  type ArchitectRevisionData,
  type ParsedArchitecture,
} from '@/api/client';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export default function ArchitectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedArchitecture | null>(null);
  const [applied, setApplied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [providers, setProviders] = useState<ArchitectProvider[]>([]);
  const [revisions, setRevisions] = useState<ArchitectRevisionData[]>([]);
  const [selectedRevisionA, setSelectedRevisionA] = useState<string | null>(null);
  const [selectedRevisionB, setSelectedRevisionB] = useState<string | null>(null);
  const [, setSessionLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadInitialState = useCallback(async () => {
    if (!projectId) return;
    try {
      const provRes = await architect.getProviders(projectId);
      setProviders(provRes.providers);

      const sessRes = await architect.getSession(projectId);
      if (sessRes.session) {
        setMessages(sessRes.session.messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })));
        if (sessRes.session.parsed_plan) {
          setParsed(sessRes.session.parsed_plan as ParsedArchitecture);
        }
      }
      if (sessRes.revisions) {
        setRevisions(sessRes.revisions);
      }
    } catch {
      // Non-fatal
    } finally {
      setSessionLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    loadInitialState();
  }, [loadInitialState]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async () => {
    if (!input.trim() || !projectId) return;
    const userMsg: ChatMessage = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    setError(null);
    try {
      const data = await architect.converse(projectId, {
        prompt: userMsg.content,
        conversation: messages.length > 0 ? messages : undefined,
      });
      setMessages([...newMessages, { role: 'assistant', content: data.content }]);
      if (data.parsed) {
        setParsed(data.parsed as ParsedArchitecture);
        setApplied(false);
      }
      // Reload revisions after each conversation turn.
      const revRes = await architect.getRevisions(projectId);
      setRevisions(revRes.revisions);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const applyPlan = async () => {
    if (!parsed || !projectId || applied) return;
    setApplying(true);
    setError(null);
    try {
      await architect.apply(projectId, parsed as Record<string, unknown>);
      setApplied(true);
      navigate(`/projects/${projectId}/architecture`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const readyProvider = providers.find((p) => p.status === 'ready');
  const revisionA = revisions.find((r) => r.id === selectedRevisionA);
  const revisionB = revisions.find((r) => r.id === selectedRevisionB);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="h-5 w-5 text-primary" />
            Architect
          </h1>
          <p className="text-sm text-muted-foreground">Describe what you want to build. The architect will generate a structured plan.</p>
        </div>
        <div className="text-right text-xs">
          {readyProvider ? (
            <div>
              <p className="font-medium text-success">{readyProvider.name}</p>
              <p className="text-muted-foreground">{readyProvider.model}</p>
            </div>
          ) : providers.length > 0 ? (
            <p className="text-muted-foreground">Provider not configured</p>
          ) : null}
        </div>
      </div>

      <Tabs defaultValue="workspace">
        <TabsList>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="revisions">Revisions ({revisions.length})</TabsTrigger>
        </TabsList>

        {/* Workspace Tab */}
        <TabsContent value="workspace" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Conversation */}
            <Card className="flex flex-col" style={{ minHeight: '500px' }}>
              <CardHeader><CardTitle className="text-sm">Conversation</CardTitle></CardHeader>
              <CardContent className="flex-1 overflow-y-auto" ref={scrollRef as React.RefObject<HTMLDivElement>}>
                {messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Sparkles className="mb-3 h-8 w-8 text-muted-foreground" />
                    <p className="text-sm font-medium">Start describing your project</p>
                    <p className="mt-1 text-xs text-muted-foreground">e.g. "Build a task management platform for small teams"</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {messages.map((msg, idx) => (
                      <div key={idx} className={`rounded-lg p-3 text-sm ${msg.role === 'user' ? 'bg-primary/10 ml-8' : 'bg-muted mr-8'}`}>
                        <p className="font-medium text-xs text-muted-foreground mb-1">{msg.role === 'user' ? 'You' : 'Architect'}</p>
                        <p className="whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    ))}
                    {loading && (
                      <div className="rounded-lg bg-muted p-3 mr-8">
                        <p className="font-medium text-xs text-muted-foreground mb-1">Architect</p>
                        <div className="flex items-center gap-2">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-primary" />
                          <span className="text-sm text-muted-foreground">Thinking…</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
              <div className="border-t p-3">
                <div className="flex gap-2">
                  <Input value={input} onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                    placeholder="Message the architect…" disabled={loading} />
                  <Button size="icon" onClick={send} disabled={loading || !input.trim() || !readyProvider}>
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
                {!readyProvider && <p className="mt-2 text-xs text-muted-foreground">Configure an LLM provider in the server environment.</p>}
              </div>
            </Card>

            {/* Generated Plan */}
            <Card className="flex flex-col" style={{ minHeight: '500px' }}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Generated Plan</CardTitle>
                {parsed && !applied && (
                  <Button size="sm" onClick={applyPlan} disabled={applying}>
                    <Check className="mr-1 h-3.5 w-3.5" />
                    {applying ? 'Applying…' : 'Apply Plan'}
                  </Button>
                )}
                {applied && (
                  <Button size="sm" variant="outline" onClick={() => navigate(`/projects/${projectId}/architecture`)}>
                    <Snowflake className="mr-1 h-3.5 w-3.5" />
                    Go to Architecture
                  </Button>
                )}
              </CardHeader>
              <CardContent className="flex-1 overflow-y-auto">
                {!parsed ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <p className="text-sm text-muted-foreground">No plan generated yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">Start a conversation to generate architecture, requirements, and work items.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {parsed.summary && (
                      <div className="rounded-md bg-muted p-3">
                        <p className="text-sm font-medium">Summary</p>
                        <p className="mt-1 text-sm text-muted-foreground">{parsed.summary}</p>
                      </div>
                    )}
                    {parsed.architecture && (
                      <div>
                        <p className="mb-1 text-sm font-medium">Architecture: {parsed.architecture.name}</p>
                        <div className="rounded-md bg-muted p-3">
                          <pre className="whitespace-pre-wrap text-xs font-mono">{parsed.architecture.content}</pre>
                        </div>
                      </div>
                    )}
                    {parsed.requirements && parsed.requirements.length > 0 && (
                      <div>
                        <p className="mb-1 text-sm font-medium">Requirements ({parsed.requirements.length})</p>
                        <div className="space-y-2">
                          {parsed.requirements.map((req) => (
                            <div key={req.requirementId} className="rounded-md border p-2">
                              <p className="text-sm font-medium">{req.requirementId}: {req.title}</p>
                              {req.description && <p className="text-xs text-muted-foreground">{req.description}</p>}
                              {req.criteria && req.criteria.length > 0 && (
                                <ul className="ml-4 mt-1 list-disc text-xs text-muted-foreground">
                                  {req.criteria.map((c) => <li key={c.criterionId}>{c.criterionId}: {c.description}</li>)}
                                </ul>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {parsed.workItems && parsed.workItems.length > 0 && (
                      <div>
                        <p className="mb-1 text-sm font-medium">Work Items ({parsed.workItems.length})</p>
                        <div className="space-y-2">
                          {parsed.workItems.map((wi) => (
                            <div key={wi.workItemId} className="rounded-md border p-2">
                              <p className="text-sm font-medium">{wi.workItemId}: {wi.title}</p>
                              {wi.objective && <p className="text-xs text-muted-foreground">{wi.objective}</p>}
                              {wi.requirementIds && wi.requirementIds.length > 0 && (
                                <p className="mt-1 text-xs text-muted-foreground">Requirements: {wi.requirementIds.join(', ')}</p>
                              )}
                              {wi.criterionIds && wi.criterionIds.length > 0 && (
                                <p className="text-xs text-muted-foreground">Criteria: {wi.criterionIds.join(', ')}</p>
                              )}
                              {wi.dependencies && wi.dependencies.length > 0 && (
                                <p className="text-xs text-muted-foreground">Depends on: {wi.dependencies.join(', ')}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Revisions Tab */}
        <TabsContent value="revisions">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <GitCompare className="h-4 w-4" />
                Revision History
              </CardTitle>
            </CardHeader>
            <CardContent>
              {revisions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No revisions yet. Start a conversation to generate revisions.</p>
              ) : (
                <div className="space-y-4">
                  {/* Revision list */}
                  <div className="space-y-2">
                    {revisions.map((rev) => (
                      <div key={rev.id} className="rounded-md border p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-medium">Revision {rev.revisionNumber}</span>
                            <span className="text-xs text-muted-foreground">{new Date(rev.createdAt).toLocaleString()}</span>
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="radio"
                              name="revisionA"
                              checked={selectedRevisionA === rev.id}
                              onChange={() => setSelectedRevisionA(rev.id)}
                              className="h-3 w-3"
                              title="Select for comparison A"
                            />
                            <input
                              type="radio"
                              name="revisionB"
                              checked={selectedRevisionB === rev.id}
                              onChange={() => setSelectedRevisionB(rev.id)}
                              className="h-3 w-3"
                              title="Select for comparison B"
                            />
                          </div>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          <span className="font-medium">You:</span> {rev.userPrompt.slice(0, 100)}{rev.userPrompt.length > 100 ? '…' : ''}
                        </p>
                        {rev.parsedPlan?.summary && (
                          <p className="text-xs text-muted-foreground">
                            <span className="font-medium">Architect:</span> {rev.parsedPlan.summary.slice(0, 100)}{rev.parsedPlan.summary.length > 100 ? '…' : ''}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Diff view */}
                  {revisionA && revisionB && revisionA.id !== revisionB.id && (
                    <div className="rounded-md border p-4">
                      <p className="mb-3 text-sm font-medium">
                        Diff: Revision {revisionA.revisionNumber} → Revision {revisionB.revisionNumber}
                      </p>
                      <RevisionDiff a={revisionA} b={revisionB} />
                    </div>
                  )}

                  {selectedRevisionA && selectedRevisionB && selectedRevisionA === selectedRevisionB && (
                    <p className="text-xs text-muted-foreground">Select two different revisions to compare.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Render a simple diff between two revisions. */
function RevisionDiff({ a, b }: { a: ArchitectRevisionData; b: ArchitectRevisionData }) {
  const planA = a.parsedPlan;
  const planB = b.parsedPlan;

  if (!planA || !planB) {
    return <p className="text-xs text-muted-foreground">One or both revisions do not have a parsed plan.</p>;
  }

  const changes: Array<{ type: 'added' | 'removed' | 'changed'; label: string; detail: string }> = [];

  // Architecture name change
  if (planA.architecture?.name !== planB.architecture?.name) {
    changes.push({ type: 'changed', label: 'Architecture name', detail: `"${planA.architecture?.name ?? '—'}" → "${planB.architecture?.name ?? '—'}"` });
  }

  // Requirements diff
  const reqsA = new Map((planA.requirements ?? []).map(r => [r.requirementId, r]));
  const reqsB = new Map((planB.requirements ?? []).map(r => [r.requirementId, r]));
  for (const [id, req] of reqsB) {
    if (!reqsA.has(id)) changes.push({ type: 'added', label: `Requirement ${id}`, detail: req.title });
  }
  for (const [id, req] of reqsA) {
    if (!reqsB.has(id)) changes.push({ type: 'removed', label: `Requirement ${id}`, detail: req.title });
  }

  // Work Items diff
  const wisA = new Map((planA.workItems ?? []).map(w => [w.workItemId, w]));
  const wisB = new Map((planB.workItems ?? []).map(w => [w.workItemId, w]));
  for (const [id, wi] of wisB) {
    if (!wisA.has(id)) changes.push({ type: 'added', label: `Work Item ${id}`, detail: wi.title });
  }
  for (const [id, wi] of wisA) {
    if (!wisB.has(id)) changes.push({ type: 'removed', label: `Work Item ${id}`, detail: wi.title });
  }

  if (changes.length === 0) {
    return <p className="text-xs text-muted-foreground">No structural changes between these revisions.</p>;
  }

  return (
    <div className="space-y-1">
      {changes.map((change, idx) => (
        <div key={idx} className={`flex items-start gap-2 text-xs ${change.type === 'added' ? 'text-success' : change.type === 'removed' ? 'text-destructive' : 'text-info'}`}>
          <span className="font-mono">{change.type === 'added' ? '+' : change.type === 'removed' ? '-' : '~'}</span>
          <span><strong>{change.label}:</strong> {change.detail}</span>
        </div>
      ))}
    </div>
  );
}

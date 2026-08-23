import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, Check, Snowflake, Sparkles } from 'lucide-react';
import {
  architect,
  type ArchitectProvider,
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
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load provider config + persisted session on mount.
  const loadInitialState = useCallback(async () => {
    if (!projectId) return;
    try {
      // Load providers.
      const provRes = await architect.getProviders(projectId);
      setProviders(provRes.providers);
      const ready = provRes.providers.find((p) => p.status === 'ready');
      if (ready) {
        setSelectedProvider(ready.provider);
        setSelectedModel(ready.model);
      }

      // Load persisted session.
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
    } catch {
      // Non-fatal — session may not exist yet.
    } finally {
      setSessionLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    loadInitialState();
  }, [loadInitialState]);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Save session whenever messages or parsed plan change.
  const saveSession = useCallback(async () => {
    if (!projectId || !sessionLoaded) return;
    try {
      await architect.saveSession(projectId, {
        messages,
        parsedPlan: parsed as Record<string, unknown> | undefined,
        provider: selectedProvider,
        model: selectedModel,
      });
    } catch {
      // Non-fatal — session persistence is best-effort.
    }
  }, [projectId, messages, parsed, selectedProvider, selectedModel, sessionLoaded]);

  useEffect(() => {
    if (sessionLoaded) saveSession();
  }, [messages, parsed, saveSession, sessionLoaded]);

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
        provider: selectedProvider || undefined,
        model: selectedModel || undefined,
      });
      setMessages([...newMessages, { role: 'assistant', content: data.content }]);
      if (data.parsed) {
        setParsed(data.parsed as ParsedArchitecture);
        setApplied(false);
      }
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
        {/* Provider readiness indicator */}
        <div className="text-right text-xs">
          {providers.length > 0 && readyProvider ? (
            <div>
              <p className="font-medium text-success">{readyProvider.name}</p>
              <p className="text-muted-foreground">{readyProvider.model}</p>
            </div>
          ) : providers.length > 0 ? (
            <p className="text-muted-foreground">Provider not configured</p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Conversation Panel */}
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
                  <div
                    key={idx}
                    className={`rounded-lg p-3 text-sm ${msg.role === 'user' ? 'bg-primary/10 ml-8' : 'bg-muted mr-8'}`}
                  >
                    <p className="font-medium text-xs text-muted-foreground mb-1">
                      {msg.role === 'user' ? 'You' : 'Architect'}
                    </p>
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
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Message the architect…"
                disabled={loading}
              />
              <Button size="icon" onClick={send} disabled={loading || !input.trim() || !readyProvider}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
            {!readyProvider && <p className="mt-2 text-xs text-muted-foreground">Configure an LLM provider in the server environment to enable the architect.</p>}
          </div>
        </Card>

        {/* Generated Artifacts Panel */}
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
                    {parsed.architecture.constraints && parsed.architecture.constraints.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs font-medium text-muted-foreground">Constraints</p>
                        <ul className="ml-4 list-disc text-xs text-muted-foreground">
                          {parsed.architecture.constraints.map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                      </div>
                    )}
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
                          {wi.dependencies && wi.dependencies.length > 0 && (
                            <p className="mt-1 text-xs text-muted-foreground">Depends on: {wi.dependencies.join(', ')}</p>
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
    </div>
  );
}

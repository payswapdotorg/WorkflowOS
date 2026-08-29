/**
 * WORK-048 — the ADVISORY recommendation card.
 *
 * Recommendations (WORK-044 routing / WORK-047 intelligence) are strictly
 * RECOMMENDATIONS. This card renders them with explicit advisory framing —
 * "recommends" — and NEVER converts a recommendation into a decision: an
 * authoritative selection exists only when an execution record says so, and
 * that is rendered by the authoritative execution surfaces, not here.
 */
import * as React from 'react';
import { Lightbulb, Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { executionRouting, type RoutingRecommendation } from '@/api/client';

interface AdvisoryCardProps {
  workItemId: string;
  workItemLabel: string;
}

export function AdvisoryCard({ workItemId, workItemLabel }: AdvisoryCardProps) {
  const { toast } = useToast();
  const [recommendation, setRecommendation] = React.useState<RoutingRecommendation | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    executionRouting
      .getRecommendation(workItemId)
      .then((r) => setRecommendation(r))
      .catch((err) => {
        // A failed advisory request NEVER fabricates a recommendation — the
        // card degrades to the explicit unavailable state.
        setRecommendation(null);
        setError(err instanceof Error ? err.message : 'Advisory unavailable');
      })
      .finally(() => setLoading(false));
  }, [workItemId]);

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="h-4 w-4" />
          Routing Recommendation
        </CardTitle>
        <CardDescription>
          Advisory only — the routing authority ranks the eligible candidates for{' '}
          {workItemLabel}. A provider is <strong>selected</strong> only when an
          execution is actually submitted; this card never decides.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="advisory-loading">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading recommendation…
          </div>
        )}
        {!loading && error && (
          <div className="flex flex-col gap-2" data-testid="advisory-unavailable">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />
              Recommendation unavailable — {error}
            </div>
            <Button variant="outline" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}
        {!loading && !error && recommendation && (
          <div className="flex flex-col gap-3" data-testid="advisory-content">
            {recommendation.selected ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">Recommends</Badge>
                <span className="text-sm font-medium">
                  {recommendation.selected.identity.provider}
                  {recommendation.selected.identity.model ? ` / ${recommendation.selected.identity.model}` : ''}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {recommendation.selected.identity.executionMode} · score{' '}
                  {recommendation.selected.score.toFixed(3)}
                </span>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                No eligible candidate — the routing authority recommends nothing
                (fail closed).
              </div>
            )}
            {recommendation.ranked.length > 1 && (
              <div className="flex flex-col gap-1">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Ranked alternatives ({recommendation.ranked.length})
                </div>
                <ul className="flex flex-col gap-1">
                  {recommendation.ranked.map((c, idx) => (
                    <li key={`${c.identity.provider}-${c.identity.model}-${idx}`} className="flex items-center gap-2 text-sm">
                      <span className="w-5 text-right font-mono text-xs text-muted-foreground">{idx + 1}.</span>
                      <span>{c.identity.provider}{c.identity.model ? ` / ${c.identity.model}` : ''}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {c.identity.executionMode} · {c.score.toFixed(3)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              {recommendation.explanation.selectionReason}
              {recommendation.explanation.excluded.length > 0 && (
                <> · {recommendation.explanation.excluded.length} excluded by hard constraints.</>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="self-start text-xs"
              onClick={() =>
                toast({
                  title: 'Advisory only',
                  description:
                    'Recommendations inform, never decide. The authoritative provider selection happens at execution submission.',
                })
              }
            >
              Why is this advisory?
            </Button>
          </div>
        )}
        {!loading && !error && !recommendation && (
          <div className="text-sm text-muted-foreground">No recommendation available.</div>
        )}
      </CardContent>
    </Card>
  );
}

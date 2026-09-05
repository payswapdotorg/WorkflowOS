import { useMemo, useState } from 'react';
import {
  workflowDeployments,
  ApiError,
  type ProductWorkflow,
  type ProductDeployment,
  type ProductTriggerSubscription,
} from '../../api/client';
import WhenEditor from './WhenEditor';
import {
  WHEN_MANUAL_PHRASE,
  SCHEDULE_UNAVAILABLE_PHRASE,
  EVENT_UNAVAILABLE_PHRASE,
  whenPhraseForSubscription,
  advancedWhenFacts,
} from './when-language';

/**
 * WhenSection — the human "When" surface (V2-017 T8, UX spec §11/§6).
 *
 * Composes the workflow's trigger facts over the EXISTING authorities
 * (the V2-009 subscriptions the page read): every configured trigger in
 * plain language, the manual mode always present (manual launch needs no
 * subscription), the contextual [Schedule] action, pause/resume through
 * the real enable/disable routes, and the expert facts behind
 * progressive disclosure.
 *
 * HONESTY RULES:
 *   - every configured subscription renders (never only the first);
 *     configured-but-disabled triggers show as "Paused" — never silently
 *     dropped, never converted into a successful "runs automatically";
 *   - unparseable authoritative facts fail closed to the honest
 *     unavailable phrases — never fabricated specifics;
 *   - no next-run computation: the occurrence math is the backend's pure
 *     function of the injected clock; only CONFIGURED facts are shown;
 *   - the followed workflow's name resolves through the page's org read;
 *     an unresolvable id degrades honestly to the generic phrase;
 *   - pause/resume state comes from the authority's own mutation
 *     response (merged over the page read until the refresh converges);
 *     typed rejections (e.g. a same-state 409) render verbatim, never as
 *     a silent success;
 *   - canonical event names, sources, typed matches, missed-window
 *     policy, and subscription ids stay inside Advanced details (the
 *     expert-only Level 3/4 surface) — never in the primary language.
 */

interface WhenSectionProps {
  workflow: ProductWorkflow;
  deployments: ProductDeployment[];
  subscriptions: ProductTriggerSubscription[];
  orgWorkflows: ProductWorkflow[];
  onChanged: () => void;
}

export default function WhenSection({ workflow, deployments, subscriptions, orgWorkflows, onChanged }: WhenSectionProps) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  // The authority's own latest mutation responses, merged over the page
  // read (the refresh converges; never a client-side derivation).
  const [enabledOverrides, setEnabledOverrides] = useState<Record<string, boolean>>({});
  // Progressive disclosure: the expert facts render only on demand.
  const [advancedIds, setAdvancedIds] = useState<ReadonlySet<string>>(new Set());

  const nameOf = useMemo(
    () => (workflowId: string) => orgWorkflows.find((w) => w.id === workflowId)?.name ?? null,
    [orgWorkflows],
  );

  const ordered = useMemo(
    () => [...subscriptions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [subscriptions],
  );

  async function toggleSubscription(subscription: ProductTriggerSubscription) {
    const next = !(enabledOverrides[subscription.id] ?? subscription.enabled);
    setPendingId(subscription.id);
    setToggleError(null);
    try {
      const result = await workflowDeployments.setSubscriptionEnabled(subscription.id, next);
      setEnabledOverrides((prev) => ({ ...prev, [subscription.id]: result.subscription.enabled }));
      onChanged();
    } catch (err) {
      // A typed rejection: the honest error, verbatim — never a state.
      setToggleError(err instanceof ApiError ? err.message : 'The trigger couldn\u2019t be changed.');
    } finally {
      setPendingId(null);
    }
  }

  function handleDone(doneNote: string) {
    setEditing(false);
    setNote(doneNote);
    onChanged();
  }

  return (
    <section aria-label="When it runs" className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-medium">When it runs</h2>
      <ul aria-label="When it runs" className="mt-3 space-y-2 text-sm">
        <li className="text-muted-foreground">{WHEN_MANUAL_PHRASE}</li>
        {ordered.map((sub) => {
          const enabled = enabledOverrides[sub.id] ?? sub.enabled;
          const phrase = whenPhraseForSubscription(sub, nameOf);
          const text =
            (sub.kind === 'schedule' ? (phrase ?? SCHEDULE_UNAVAILABLE_PHRASE) : phrase ?? EVENT_UNAVAILABLE_PHRASE) +
            (enabled ? '' : ' · Paused');
          const busy = pendingId === sub.id;
          return (
            <li key={sub.id} className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className={enabled ? '' : 'text-muted-foreground'}>{text}</span>
                <button
                  type="button"
                  onClick={() => void toggleSubscription(sub)}
                  disabled={busy}
                  className="rounded-md border border-border px-2 py-0.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                >
                  {busy ? (enabled ? 'Pausing…' : 'Resuming…') : enabled ? 'Pause' : 'Resume'}
                </button>
              </div>
              <details
                className="text-xs"
                open={advancedIds.has(sub.id)}
                onToggle={(e) =>
                  setAdvancedIds((prev) => {
                    const next = new Set(prev);
                    if (e.currentTarget.open) next.add(sub.id);
                    else next.delete(sub.id);
                    return next;
                  })
                }
              >
                <summary className="cursor-pointer text-muted-foreground">Advanced details</summary>
                {advancedIds.has(sub.id) && (
                  <ul aria-label="Advanced when facts" className="mt-1 space-y-0.5 pl-4 text-muted-foreground">
                    {advancedWhenFacts(sub).map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                )}
              </details>
            </li>
          );
        })}
      </ul>
      {toggleError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {toggleError}
        </p>
      )}
      {editing ? (
        <WhenEditor
          workflow={workflow}
          deployments={deployments}
          orgWorkflows={orgWorkflows}
          onDone={handleDone}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setNote(null);
            setEditing(true);
          }}
          className="mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          Schedule
        </button>
      )}
      {note && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {note}
        </p>
      )}
    </section>
  );
}

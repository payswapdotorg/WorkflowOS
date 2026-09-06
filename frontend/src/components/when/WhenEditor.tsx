import { useMemo, useState } from 'react';
import {
  workflowDeployments,
  ApiError,
  type ProductWorkflow,
  type ProductDeployment,
  type ProductCreateSubscriptionInput,
} from '../../api/client';
import { EVENT_PHRASES, whenPhraseForSubscription } from './when-language';

/**
 * WhenEditor — the §11 trigger-choice editor (V2-017 T8).
 *
 * The five plain-language choices (Run now / At a time / On a schedule /
 * When something happens / After another workflow) over the REAL
 * V2-009 create-or-converge routes. Progressive disclosure: the simple
 * surface asks only what the choice needs (§2.3); timezone, missed-window
 * policy, and event source appear only inside "Advanced controls".
 *
 * HONESTY RULES:
 *   - the wire formats are the canonical ones, verbatim: fixed-UTC
 *     one-shot instants, IANA timezone + HH:MM schedules, sorted ISO
 *     weekdays, frozen-registry event names, typed workflowId matches;
 *   - the frontend never re-validates scheduling semantics — required
 *     inputs are guarded, but every semantic decision (including
 *     "is this timezone real", "is this schedule valid") stays the
 *     backend's; typed rejections render verbatim as alerts, never as
 *     state, and the editor stays open for correction;
 *   - the delivery policy is sent ONLY when the advanced control moves
 *     it off the documented default (the backend owns the defaults);
 *   - when no deployment exists, the subscription attach point is
 *     created first through the real create-or-converge route (the
 *     workflow's head version pinned; any-supported placement — the
 *     universally compatible default);
 *   - "Run now" is the manual mode: no subscription exists for manual
 *     launch, so the choice explains it and sends nothing.
 */

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

interface WhenEditorProps {
  workflow: ProductWorkflow;
  deployments: ProductDeployment[];
  orgWorkflows: ProductWorkflow[];
  /** REALITY-REPAIR-003 (F-003): the org the deployment create operates
   *  in — the INSTALLATION's organization (the caller's local org for a
   *  marketplace consumer; the workflow's own org on the owner path). */
  commandOrganizationId: string;
  /** Success: the note to surface + the page refresh. */
  onDone: (note: string) => void;
  onCancel: () => void;
}

type Mode = 'run-now' | 'at-time' | 'schedule' | 'event' | 'after-workflow';

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'run-now', label: 'Run now', hint: 'It runs when you start it. No automatic schedule is set.' },
  { value: 'at-time', label: 'At a time', hint: 'Runs once, at a moment you choose.' },
  { value: 'schedule', label: 'On a schedule', hint: 'Runs repeatedly, on days and times you choose.' },
  { value: 'event', label: 'When something happens', hint: 'Runs when a real event happens.' },
  { value: 'after-workflow', label: 'After another workflow', hint: 'Runs when another workflow finishes.' },
];

export default function WhenEditor({ workflow, deployments, orgWorkflows, commandOrganizationId, onDone, onCancel }: WhenEditorProps) {
  const [mode, setMode] = useState<Mode>('run-now');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('09:00');
  const [repeat, setRepeat] = useState<'daily' | 'weekly' | 'interval'>('daily');
  const [days, setDays] = useState<ReadonlySet<number>>(new Set<number>());
  const [everyCount, setEveryCount] = useState('30');
  const [everyUnit, setEveryUnit] = useState<'minutes' | 'hours'>('minutes');
  const [timezone, setTimezone] = useState('UTC');
  const [missedWindow, setMissedWindow] = useState<'skip' | 'catch_up_run_now'>('skip');
  const [eventType, setEventType] = useState('file.changed');
  const [eventSource, setEventSource] = useState('');
  const [afterWorkflowId, setAfterWorkflowId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const nameOf = useMemo(
    () => (workflowId: string) => orgWorkflows.find((w) => w.id === workflowId)?.name ?? null,
    [orgWorkflows],
  );

  const incomplete =
    (mode === 'at-time' && (date === '' || time === '')) ||
    (mode === 'schedule' &&
      (time === '' ||
        (repeat === 'weekly' && days.size === 0) ||
        (repeat === 'interval' && (everyCount === '' || !Number.isFinite(Number(everyCount)) || Number(everyCount) <= 0)))) ||
    (mode === 'after-workflow' && afterWorkflowId === '');

  function toggleDay(iso: number) {
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  }

  function buildInput(): ProductCreateSubscriptionInput {
    switch (mode) {
      case 'at-time':
        return { kind: 'schedule', schedule: { kind: 'one_shot', at: `${date}T${time}:00.000Z` }, enabled: true };
      case 'schedule': {
        if (repeat === 'daily') {
          return { kind: 'schedule', schedule: { kind: 'daily', timezone, timeOfDay: time }, enabled: true };
        }
        if (repeat === 'weekly') {
          return {
            kind: 'schedule',
            schedule: { kind: 'weekly', timezone, timeOfDay: time, daysOfWeek: [...days].sort((a, b) => a - b) },
            enabled: true,
          };
        }
        const factor = everyUnit === 'hours' ? 3_600_000 : 60_000;
        return {
          kind: 'schedule',
          schedule: { kind: 'interval', everyMs: Math.round(Number(everyCount) * factor) },
          enabled: true,
        };
      }
      case 'event': {
        const pattern: ProductCreateSubscriptionInput['eventPattern'] = { eventType };
        if (eventSource.trim() !== '') pattern.source = eventSource.trim();
        return { kind: 'event', eventPattern: pattern, enabled: true };
      }
      case 'after-workflow':
        return {
          kind: 'event',
          eventPattern: {
            eventType: 'workflow.run.completed',
            match: [{ field: 'workflowId', value: afterWorkflowId }],
          },
          enabled: true,
        };
      default:
        return { kind: 'schedule', schedule: { kind: 'daily', timezone, timeOfDay: time }, enabled: true };
    }
  }

  function buildDeliveryPolicy(): Partial<ProductCreateSubscriptionInput['deliveryPolicy']> | undefined {
    // Only a non-default choice travels — the backend owns the defaults.
    return missedWindow === 'skip' ? undefined : { missedWindow };
  }

  async function save() {
    if (mode === 'run-now') {
      onDone('It runs when you start it. No automatic schedule is set.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // The attach point: an existing deployment (the enabled one first —
      // subscriptions on a disabled deployment never deliver), or the real
      // create-or-converge route when none exists.
      let deployment = deployments.find((d) => d.enabled) ?? deployments[0];
      if (!deployment) {
        if (workflow.headVersionId === null) {
          // A workflow with no version cannot pin a deployment (the
          // authority would reject it) — the honest guard, stated plainly.
          setError('This workflow has no version to schedule yet.');
          return;
        }
        // REALITY-REPAIR-003 (F-003): the deployment is created in the
        // CALLER's organization (commandOrganizationId — the
        // installation's org for a marketplace consumer), so its
        // subscriptions deliver runs as the caller's local facts — never
        // in the publisher's organization (whose member-only command
        // 403s the consumer).
        const created = await workflowDeployments.createDeployment(commandOrganizationId, {
          workflowId: workflow.id,
          versionId: workflow.headVersionId,
          name: workflow.name,
          placement: { placement: { required: 'any_supported_node' }, privacy: { localOnly: false } },
        });
        deployment = created.deployment;
      }
      const input = buildInput();
      const deliveryPolicy = buildDeliveryPolicy();
      const result = await workflowDeployments.createSubscription(deployment.id, {
        ...input,
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
      });
      onDone(`Scheduled · ${whenPhraseForSubscription(result.subscription, nameOf) ?? 'The trigger is set.'}`);
    } catch (err) {
      // A typed rejection: the honest error, verbatim — never a state.
      setError(err instanceof ApiError ? err.message : 'The trigger couldn\u2019t be saved.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="When editor" className="mt-4 space-y-4 rounded-xl border border-border bg-accent/20 p-4">
      <h3 className="text-sm font-medium">When does it run?</h3>

      <fieldset className="space-y-2">
        <legend className="sr-only">When does it run?</legend>
        {MODES.map((m) => (
          <div key={m.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              id={`when-mode-${m.value}`}
              name="when-mode"
              value={m.value}
              checked={mode === m.value}
              onChange={() => setMode(m.value)}
              className="mt-1"
            />
            <div>
              <label htmlFor={`when-mode-${m.value}`} className="font-medium">
                {m.label}
              </label>
              <p className="text-xs text-muted-foreground">{m.hint}</p>
            </div>
          </div>
        ))}
      </fieldset>

      {mode === 'at-time' && (
        <div className="flex flex-wrap gap-3 text-sm">
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">Date (UTC)</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">Time (UTC)</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
        </div>
      )}

      {mode === 'schedule' && (
        <div className="space-y-3 text-sm">
          <label className="block space-y-1">
            <span className="block text-xs text-muted-foreground">How often?</span>
            <select
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as 'daily' | 'weekly' | 'interval')}
              aria-label="How often?"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="daily">Every day</option>
              <option value="weekly">Certain days</option>
              <option value="interval">At an interval</option>
            </select>
          </label>
          {repeat === 'weekly' && (
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((label, index) => (
                <label key={label} className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={days.has(index + 1)}
                    onChange={() => toggleDay(index + 1)}
                    aria-label={label}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
          {repeat === 'interval' && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">Every</span>
                <input
                  type="number"
                  min={1}
                  value={everyCount}
                  onChange={(e) => setEveryCount(e.target.value)}
                  className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">Interval unit</span>
                <select
                  value={everyUnit}
                  onChange={(e) => setEveryUnit(e.target.value as 'minutes' | 'hours')}
                  aria-label="Interval unit"
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </label>
            </div>
          )}
          <label className="block space-y-1">
            <span className="block text-xs text-muted-foreground">Time</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
        </div>
      )}

      {mode === 'event' && (
        <label className="block space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">What event?</span>
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            aria-label="What event?"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            {Object.entries(EVENT_PHRASES).map(([name, phrase]) => (
              <option key={name} value={name}>
                {phrase}
              </option>
            ))}
          </select>
        </label>
      )}

      {mode === 'after-workflow' && (
        <label className="block space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Which workflow?</span>
          <select
            value={afterWorkflowId}
            onChange={(e) => setAfterWorkflowId(e.target.value)}
            aria-label="Which workflow?"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="">Choose a workflow…</option>
            {orgWorkflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {(mode === 'schedule' || mode === 'event') && (
        <details
          className="text-sm"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        >
          <summary className="cursor-pointer text-muted-foreground">Advanced controls</summary>
          {advancedOpen && (
            <div className="mt-2 space-y-3 pl-1">
              {mode === 'schedule' && (
                <>
                  <label className="block space-y-1">
                    <span className="block text-xs text-muted-foreground">Timezone</span>
                    <input
                      type="text"
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      aria-label="Timezone"
                      className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="block text-xs text-muted-foreground">If a run is missed</span>
                    <select
                      value={missedWindow}
                      onChange={(e) => setMissedWindow(e.target.value as 'skip' | 'catch_up_run_now')}
                      aria-label="If a run is missed"
                      className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                    >
                      <option value="skip">Skip it (default)</option>
                      <option value="catch_up_run_now">Run the latest missed one now</option>
                    </select>
                  </label>
                </>
              )}
              {mode === 'event' && (
                <label className="block space-y-1">
                  <span className="block text-xs text-muted-foreground">Source</span>
                  <input
                    type="text"
                    value={eventSource}
                    onChange={(e) => setEventSource(e.target.value)}
                    aria-label="Source"
                    placeholder="Only events from this source"
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                  />
                </label>
              )}
            </div>
          )}
        </details>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={incomplete || submitting}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

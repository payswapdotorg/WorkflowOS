/**
 * V2-017 T8 — the shared human "When" vocabulary (Issue #196).
 *
 * PURE presentation functions over the V2-009 wire shapes. This module
 * NEVER derives occurrences, never computes "next run" times, never
 * re-validates authoritative semantics: it renders the CONFIGURED facts
 * (schedule specs, event patterns) in plain language (UX spec §11 /
 * §2.6 — "When" rather than "Trigger definition").
 *
 * Honesty rules:
 *   - unparseable/unknown authoritative facts fail closed to `null` (the
 *     caller renders the honest unavailable phrase) — never fabricated
 *     specifics, never a partial derivation;
 *   - the time-of-day / date presentation is string formatting of the
 *     authoritative values only (no clock math, no Date API, no
 *     occurrence derivation — that is the backend's pure function of the
 *     injected clock);
 *   - canonical registry event names are NOT human phrases: the phrase
 *     map below is the presentation vocabulary; the canonical names stay
 *     expert-only (Advanced details).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** The manual trigger mode (manual launch needs no subscription). */
export const WHEN_MANUAL_PHRASE = 'Runs when you start it';

/** The honest unavailable phrases (fail-closed presentation). */
export const SCHEDULE_UNAVAILABLE_PHRASE = 'Runs on a schedule (details unavailable)';
export const EVENT_UNAVAILABLE_PHRASE = 'Runs on events (details unavailable)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * "HH:MM" (the authoritative 24h zero-padded form) → familiar 12h
 * presentation. String formatting only — no clock math.
 */
export function formatTimeOfDay(timeOfDay: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay);
  if (!match) return timeOfDay;
  const hours = Number(match[1]);
  const minutes = match[2];
  const suffix = hours < 12 ? 'AM' : 'PM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${minutes} ${suffix}`;
}

/** The date part of a fixed-UTC timestamp → "Sep 6, 2026" (string parse only). */
export function formatDatePart(fixedUtc: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(fixedUtc);
  if (!match) return fixedUtc;
  const month = MONTHS[Number(match[2]) - 1] ?? match[2];
  const day = Number(match[3]);
  return `${month} ${day}, ${match[1]}`;
}

/** The schedule-spec When phrase; null = not honestly presentable. */
export function scheduleWhenPhrase(spec: unknown): string | null {
  if (!isRecord(spec)) return null;
  switch (spec.kind) {
    case 'one_shot': {
      if (typeof spec.at !== 'string') return null;
      const time = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(spec.at);
      if (!time) return null;
      return `Runs once · ${formatDatePart(spec.at)} at ${formatTimeOfDay(time[2])} UTC`;
    }
    case 'interval': {
      if (typeof spec.everyMs !== 'number' || !Number.isFinite(spec.everyMs) || spec.everyMs <= 0) {
        return null;
      }
      if (spec.everyMs % 3_600_000 === 0) {
        const hours = spec.everyMs / 3_600_000;
        return hours === 1 ? 'Runs every hour' : `Runs every ${hours} hours`;
      }
      if (spec.everyMs % 60_000 === 0) {
        const minutes = spec.everyMs / 60_000;
        return minutes === 1 ? 'Runs every minute' : `Runs every ${minutes} minutes`;
      }
      if (spec.everyMs % 1_000 === 0) {
        return `Runs every ${spec.everyMs / 1_000} seconds`;
      }
      return `Runs every ${spec.everyMs} ms`;
    }
    case 'daily': {
      if (typeof spec.timeOfDay !== 'string' || typeof spec.timezone !== 'string') return null;
      return `Runs every day · ${formatTimeOfDay(spec.timeOfDay)} ${spec.timezone}`;
    }
    case 'weekly': {
      if (
        typeof spec.timeOfDay !== 'string' ||
        typeof spec.timezone !== 'string' ||
        !Array.isArray(spec.daysOfWeek) ||
        spec.daysOfWeek.length === 0
      ) {
        return null;
      }
      const days = spec.daysOfWeek.filter((d): d is number => typeof d === 'number' && d >= 1 && d <= 7);
      if (days.length !== spec.daysOfWeek.length) return null;
      const sorted = [...days].sort((a, b) => a - b);
      const at = `· ${formatTimeOfDay(spec.timeOfDay)} ${spec.timezone}`;
      if (sorted.length === 7) return `Runs every day ${at}`;
      if (sorted.length === 1) return `Runs every ${WEEKDAY_FULL[sorted[0] - 1]} ${at}`;
      return `Runs every ${sorted.map((d) => WEEKDAY_SHORT[d - 1]).join(', ')} ${at}`;
    }
    default:
      return null;
  }
}

/**
 * The human phrases for the frozen registry event vocabulary
 * (V2-CTRL-003, verbatim names — the phrases are the presentation).
 * Unknown names have no phrase (fail closed).
 */
export const EVENT_PHRASES: Readonly<Record<string, string>> = {
  'workflow.run.requested': 'a workflow run is requested',
  'workflow.run.started': 'a workflow run starts',
  'workflow.step.started': 'a workflow step starts',
  'workflow.step.completed': 'a workflow step completes',
  'workflow.run.paused': 'a workflow run is paused',
  'workflow.run.resumed': 'a workflow run resumes',
  'workflow.run.completed': 'a workflow finishes',
  'workflow.run.failed': 'a workflow run fails',
  'capability.invocation.requested': 'a capability is invoked',
  'capability.invocation.completed': 'a capability invocation completes',
  'observation.recorded': 'an observation is recorded',
  'verification.completed': 'a verification completes',
  'execution.attestation.issued': 'an attestation is issued',
  'execution.attestation.verified': 'an attestation is verified',
  'execution.proof.updated': 'a proof is updated',
  'device.connected': 'a device connects',
  'device.disconnected': 'a device disconnects',
  'phone.call.received': 'a phone call comes in',
  'phone.call.ended': 'a phone call ends',
  'messaging.message.received': 'a message arrives',
  'notification.received': 'a notification arrives',
  'file.created': 'a file is created',
  'file.changed': 'a file changes',
  'application.opened': 'an application opens',
  'social.post.engagement.threshold_crossed': 'a post crosses an engagement threshold',
  'workflow.deployment.enabled': 'a workflow is enabled',
  'workflow.deployment.disabled': 'a workflow is disabled',
};

/** The phrase for one registry event name (null = unknown to the map). */
export function eventPhraseOf(eventType: string): string | null {
  return EVENT_PHRASES[eventType] ?? null;
}

/**
 * The event-pattern When phrase. The workflow-completion trigger (the
 * registry's `workflow.run.completed` with a typed workflowId match) is
 * the "After another workflow" mode: the followed workflow's NAME is
 * resolved through the caller's read (the V2-002 org list); an
 * unresolvable id fails closed to the honest generic phrase — never a
 * fabricated name.
 */
export function eventWhenPhrase(
  pattern: unknown,
  resolveWorkflowName: (workflowId: string) => string | null,
): string | null {
  if (!isRecord(pattern) || typeof pattern.eventType !== 'string') return null;
  if (pattern.eventType === 'workflow.run.completed') {
    const match = Array.isArray(pattern.match)
      ? pattern.match.find(
          (m): m is { field: string; value: string } =>
            isRecord(m) && m.field === 'workflowId' && typeof m.value === 'string',
        )
      : undefined;
    if (match) {
      const name = resolveWorkflowName(match.value);
      return name === null ? 'Runs after another workflow finishes' : `Runs after ${name} finishes`;
    }
    return 'Runs when any workflow finishes';
  }
  const phrase = eventPhraseOf(pattern.eventType);
  return phrase === null ? null : `Runs when ${phrase}`;
}

/** The When phrase for one trigger subscription (fail-closed → null). */
export function whenPhraseForSubscription(
  subscription: { kind: unknown; schedule: unknown; eventPattern: unknown },
  resolveWorkflowName: (workflowId: string) => string | null,
): string | null {
  if (subscription.kind === 'schedule') {
    return scheduleWhenPhrase(subscription.schedule);
  }
  if (subscription.kind === 'event') {
    return eventWhenPhrase(subscription.eventPattern, resolveWorkflowName);
  }
  return null;
}

/**
 * The Advanced-details facts for one subscription (the expert-only
 * surface: canonical event names, sources, typed matches, timezone,
 * missed-window policy, and the subscription identifier — Level 3/4).
 */
export function advancedWhenFacts(subscription: {
  id: string;
  kind: unknown;
  schedule: unknown;
  eventPattern: unknown;
  deliveryPolicy: unknown;
}): string[] {
  const facts: string[] = [];
  if (subscription.kind === 'event' && isRecord(subscription.eventPattern)) {
    if (typeof subscription.eventPattern.eventType === 'string') {
      facts.push(`Event type: ${subscription.eventPattern.eventType}`);
    }
    if (typeof subscription.eventPattern.source === 'string' && subscription.eventPattern.source !== '') {
      facts.push(`Source: ${subscription.eventPattern.source}`);
    }
    if (Array.isArray(subscription.eventPattern.match)) {
      for (const m of subscription.eventPattern.match) {
        if (
          isRecord(m) &&
          typeof m.field === 'string' &&
          (typeof m.value === 'string' || typeof m.value === 'number' || typeof m.value === 'boolean')
        ) {
          facts.push(`Match: ${m.field} = ${typeof m.value === 'string' ? m.value : String(m.value)}`);
        }
      }
    }
  }
  if (subscription.kind === 'schedule' && isRecord(subscription.schedule)) {
    if (typeof subscription.schedule.timezone === 'string') {
      facts.push(`Timezone: ${subscription.schedule.timezone}`);
    }
  }
  if (isRecord(subscription.deliveryPolicy)) {
    if (
      subscription.deliveryPolicy.missedWindow === 'skip' ||
      subscription.deliveryPolicy.missedWindow === 'catch_up_run_now'
    ) {
      facts.push(`Missed window: ${subscription.deliveryPolicy.missedWindow}`);
    }
  }
  facts.push(`Subscription: ${subscription.id}`);
  return facts;
}

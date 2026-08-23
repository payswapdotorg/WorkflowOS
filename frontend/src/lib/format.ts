/**
 * Formatting helpers — pure presentational utilities. They never derive
 * workflow state, evaluate evidence, or compute authorization. They only
 * shape backend-supplied values for display.
 */

/** Format an ISO timestamp as a short, locale-aware date-time string. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format an ISO timestamp as a relative "5m ago" / "in 2h" string. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = date.getTime() - Date.now();
  const past = diffMs < 0;
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (sec < 45) return past ? 'just now' : 'in a moment';
  if (min < 60) return past ? `${min}m ago` : `in ${min}m`;
  if (hr < 24) return past ? `${hr}h ago` : `in ${hr}h`;
  if (day < 30) return past ? `${day}d ago` : `in ${day}d`;
  return formatDateTime(iso);
}

/** Truncate a UUID/long id to a stable 8-char prefix. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** Title-case a snake_case identifier. */
export function titleCase(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Title-case a workflow state (e.g. `architect_review` → `Architect Review`).
 * The frontend does NOT own canonical workflow states — this is purely a
 * display transform over a backend-supplied string.
 */
export function humanizeState(state: string | null | undefined): string {
  return titleCase(state);
}

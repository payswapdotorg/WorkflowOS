import { cn } from '@/lib/cn';
import { formatRelative, formatDateTime, titleCase } from '@/lib/format';
import type { AuditEvent } from '@/api/client';

/**
 * AuditEventItem — a single row in the audit timeline. The frontend never
 * writes audit events; it only reads from `GET /projects/:id/audit` and
 * `GET /work-items/:id/audit`. Each event is rendered as a timeline row
 * with the event type, actor, source, resource, and timestamp — all
 * backend-supplied.
 */
interface AuditEventItemProps {
  event: AuditEvent;
  className?: string;
}

const EVENT_TONE: Record<string, string> = {
  created: 'bg-success',
  transitioned: 'bg-primary',
  rejected: 'bg-destructive',
  failed: 'bg-destructive',
  approved: 'bg-success',
  merged: 'bg-success',
  frozen: 'bg-info',
  signed: 'bg-info',
  attached: 'bg-info',
  mapped: 'bg-info',
  opened: 'bg-primary',
  closed: 'bg-muted-foreground',
  verified: 'bg-success',
};

function toneFor(eventType: string): string {
  const key = eventType.toLowerCase();
  for (const keyword of Object.keys(EVENT_TONE)) {
    if (key.includes(keyword)) return EVENT_TONE[keyword]!;
  }
  return 'bg-muted-foreground';
}

export function AuditEventItem({ event, className }: AuditEventItemProps) {
  const tone = toneFor(event.eventType);
  return (
    <li className={cn('relative flex gap-3 pb-5 last:pb-0', className)}>
      <div className="flex flex-col items-center">
        <span
          aria-hidden="true"
          className={cn(
            'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full',
            tone,
          )}
        />
        <span
          aria-hidden="true"
          className="mt-1 w-px flex-1 bg-border last:hidden"
        />
      </div>
      <div className="flex flex-1 flex-col gap-0.5 pb-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-foreground">
            {titleCase(event.eventType)}
          </span>
          <span className="text-xs text-muted-foreground">
            by <span className="font-mono">{event.actor || 'system'}</span>
          </span>
          {event.source && (
            <span className="text-xs text-muted-foreground">
              · {event.source}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">
            {event.resourceType}/{event.resourceId.slice(0, 8)}
          </span>
          {event.executionId && (
            <span className="font-mono text-[10px] opacity-70">
              exec {event.executionId.slice(0, 8)}
            </span>
          )}
          <span
            title={formatDateTime(event.createdAt)}
            className="ml-auto"
          >
            {formatRelative(event.createdAt)}
          </span>
        </div>
      </div>
    </li>
  );
}

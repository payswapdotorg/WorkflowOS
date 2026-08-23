import * as React from 'react';
import { FileCheck2, ShieldCheck, FileText, GitBranch, Boxes } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDateTime, shortId } from '@/lib/format';
import type { VerificationEvidence } from '@/api/client';
import { Badge } from '@/components/ui/badge';

/**
 * EvidenceCard — renders a single VerificationEvidence row (authoritative
 * backend record). The frontend NEVER constructs evidence — it only
 * displays what /verification persisted. The "authority" field comes
 * straight from the backend (the trusted CI path produces
 * `authority: 'authoritative'`; the manual public path produces
 * `authority: 'claim'`).
 */
const ICON_BY_TYPE: Record<string, React.ComponentType<{ className?: string }>> = {
  ci: FileCheck2,
  test: ShieldCheck,
  coverage: ShieldCheck,
  scan: ShieldCheck,
  document: FileText,
  pr: GitBranch,
};

const RESULT_TONE: Record<string, string> = {
  pass: 'text-success',
  fail: 'text-destructive',
  blocked: 'text-warning',
  unknown: 'text-muted-foreground',
};

export interface EvidenceCardProps {
  evidence: VerificationEvidence;
  className?: string;
  /** Optional flag — if true, render the testid `evidence-${id}` (preserves
   *  the WORK-022 rendered-UI contract). */
  withTestId?: boolean;
}

export function EvidenceCard({
  evidence,
  className,
  withTestId = true,
}: EvidenceCardProps) {
  const typeKey = (evidence.evidenceType || '').toLowerCase();
  const Icon = ICON_BY_TYPE[typeKey] ?? Boxes;
  const resultClass = RESULT_TONE[(evidence.result || '').toLowerCase()] ?? 'text-muted-foreground';
  return (
    <div
      data-testid={withTestId ? `evidence-${evidence.id}` : undefined}
      className={cn(
        'flex flex-col gap-2 rounded-md border border-border bg-card p-3',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {evidence.evidenceType}
            </span>
            <span className="text-xs text-muted-foreground">
              {evidence.provider}
            </span>
          </div>
        </div>
        <span
          className={cn('text-xs font-semibold uppercase', resultClass)}
          data-testid={withTestId ? `evidence-${evidence.id}-result` : undefined}
        >
          {evidence.result || 'unknown'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Badge variant="outline" data-testid={withTestId ? `evidence-${evidence.id}-authority` : undefined}>
          {evidence.authority}
        </Badge>
        {evidence.headSha && (
          <Badge variant="outline">
            <span className="font-mono">{shortId(evidence.headSha)}</span>
          </Badge>
        )}
        {evidence.externalRef && (
          <span className="font-mono text-muted-foreground">
            {evidence.externalRef}
          </span>
        )}
        <span className="ml-auto text-muted-foreground">
          {formatDateTime(evidence.createdAt)}
        </span>
      </div>
      {evidence.contentSummary && (
        <p className="text-xs text-muted-foreground">{evidence.contentSummary}</p>
      )}
    </div>
  );
}

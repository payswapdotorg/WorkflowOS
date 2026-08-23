import * as React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDateTime, shortId } from '@/lib/format';
import { StatusBadge } from '@/components/domain/status-badge';
import type { ImplementationContextContent } from '@/api/client';

/**
 * WORK-026 (SUB-I): ImplementationContextViewer — reusable display for the
 * ImplementationContextContent payload produced by
 * `DefaultImplementationContextBuilder.build()` (persisted via
 * `PgImplementationContextRepository`).
 *
 * The component is purely presentational: it accepts the content as a prop and
 * renders it as structured, collapsible sections. It never fetches anything,
 * never mutates state, and never reaches into backend internals. A future GET
 * /work-items/:workItemId/implementation-context endpoint (NOT implemented
 * today — see worklog SUB-H note at line 3594) would feed this component; in
 * the meantime, callers can pass any `ImplementationContextContent`-shaped
 * object (e.g. constructed from the start-implementation response summary).
 *
 * Mobile-first: each section is collapsible so long content doesn't dominate
 * the viewport. The repo + PR metadata row renders inline (single-line) on
 * wide screens and stacks on mobile.
 */

interface ImplementationContextViewerProps {
  content: ImplementationContextContent;
  /** Optional revision number — displayed in the header when provided. */
  revision?: number;
  /** Optional kind label — 'initial' | 'correction'. */
  kind?: 'initial' | 'correction';
  className?: string;
  /**
   * When true (default), sections are collapsed by default and the user
   * expands them. Set false to render everything inline (e.g. inside a Dialog
   * where the user explicitly requested the full view).
   */
  defaultCollapsed?: boolean;
}

interface SectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  /** Badge-style count or status to render in the header (e.g. "(3)"). */
  hint?: React.ReactNode;
}

function Section({ title, defaultOpen = false, children, hint }: SectionProps) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="flex-1">{title}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </button>
      {open && <div className="border-t border-border px-3 py-3 text-sm">{children}</div>}
    </div>
  );
}

function Block({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="space-y-1">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="whitespace-pre-wrap break-words text-sm text-foreground">
        {value && value.trim().length > 0 ? value : <span className="text-muted-foreground">—</span>}
      </dd>
    </div>
  );
}

function ListItems({ items, empty = 'None' }: { items: string[]; empty?: string }) {
  if (!items || items.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
      {items.map((item, idx) => (
        <li key={idx} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

export function ImplementationContextViewer({
  content,
  revision,
  kind,
  className,
  defaultCollapsed = true,
}: ImplementationContextViewerProps) {
  const repo = content.repository;
  const repoLine =
    repo?.owner && repo?.repository
      ? `${repo.owner}/${repo.repository}`
      : null;
  const branchLine = repo?.implementationBranch ?? repo?.defaultBranch ?? null;
  const pr = repo?.currentPullRequest ?? null;

  return (
    <div className={cn('space-y-3', className)}>
      {(revision !== undefined || kind) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {revision !== undefined && (
            <span>
              Revision <span className="font-mono text-foreground">#{revision}</span>
            </span>
          )}
          {kind && <StatusBadge value={kind} humanize />}
        </div>
      )}

      {/* Core context — collapsed by default */}
      <Section title="Objective & Scope" defaultOpen={!defaultCollapsed}>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Block label="Objective" value={content.objective} />
          <Block label="Scope" value={content.scope} />
          <Block label="Out of scope" value={content.outOfScope} />
          <Block label="Architecture constraints" value={content.architectureConstraints} />
        </dl>
      </Section>

      {/* Repository + PR — shown inline */}
      <Section
        title="Repository & Pull Request"
        defaultOpen={!defaultCollapsed}
        hint={repoLine ? <span className="font-mono">{repoLine}</span> : undefined}
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <Block label="Owner" value={repo?.owner ?? null} />
          <Block label="Repository" value={repo?.repository ?? null} />
          <Block label="Default branch" value={repo?.defaultBranch ?? null} />
          <Block label="Implementation branch" value={repo?.implementationBranch ?? null} />
        </dl>
        {pr ? (
          <div className="mt-3 rounded-md border border-border bg-muted/30 p-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium">PR #{pr.number}</span>
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                View on GitHub
              </a>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              head: {pr.headSha}
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">No active pull request.</p>
        )}
        {branchLine && (
          <p className="mt-3 text-xs text-muted-foreground">
            Active branch: <span className="font-mono text-foreground">{branchLine}</span>
          </p>
        )}
      </Section>

      {/* Requirements + criteria */}
      <Section
        title="Requirements & Criteria"
        defaultOpen={!defaultCollapsed}
        hint={content.requirements.length > 0 ? `(${content.requirements.length})` : undefined}
      >
        {content.requirements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No requirements resolved.</p>
        ) : (
          <ol className="space-y-3">
            {content.requirements.map((req) => (
              <li key={req.requirementId} className="rounded-md border border-border p-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {req.requirementId}
                  </span>
                  <span className="font-medium">{req.title}</span>
                </div>
                {req.description && (
                  <p className="mt-1 text-xs text-muted-foreground">{req.description}</p>
                )}
                {req.criteria.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
                    {req.criteria.map((c) => (
                      <li key={c.criterionId}>
                        <span className="font-mono text-muted-foreground">{c.criterionId}</span>
                        {' — '}
                        {c.description}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>

      {/* Dependencies */}
      <Section
        title="Dependencies"
        defaultOpen={!defaultCollapsed}
        hint={content.dependencies.length > 0 ? `(${content.dependencies.length})` : undefined}
      >
        {content.dependencies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No dependencies.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {content.dependencies.map((d) => (
              <li key={d.workItemId}>
                <span className="font-mono text-xs text-muted-foreground">{d.workItemId}</span>
                {' — '}
                {d.title}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Verification expectations */}
      <Section
        title="Verification Expectations"
        defaultOpen={!defaultCollapsed}
      >
        <div className="space-y-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Expected tests
            </p>
            <ListItems items={content.expectedTests} />
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Verification requirements
            </p>
            <ListItems items={content.verificationRequirements} />
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Browser test requirements
            </p>
            <ListItems items={content.browserTestRequirements} />
          </div>
        </div>
      </Section>

      {/* Prior agent runs */}
      <Section
        title="Prior Agent Runs"
        defaultOpen={defaultCollapsed}
        hint={content.priorAgentRuns.length > 0 ? `(${content.priorAgentRuns.length})` : undefined}
      >
        {content.priorAgentRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prior agent runs (initial run).</p>
        ) : (
          <ol className="space-y-2">
            {content.priorAgentRuns.map((ar, idx) => (
              <li
                key={`${ar.executionId}-${idx}`}
                className="rounded-md border border-border p-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge value={ar.status} />
                  <span className="font-mono">{ar.provider}/{ar.model}</span>
                  <span className="font-mono text-muted-foreground">
                    exec:{shortId(ar.executionId)}
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {formatDateTime(ar.createdAt)}
                  {ar.commitRef && <span className="ml-2 font-mono">commit: {shortId(ar.commitRef)}</span>}
                  {ar.pullRequestRef && <span className="ml-2 font-mono">PR: {ar.pullRequestRef}</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {/* Prior review findings */}
      <Section
        title="Prior Review Findings"
        defaultOpen={defaultCollapsed}
        hint={
          content.priorReviewFindings.length > 0
            ? `(${content.priorReviewFindings.length})`
            : undefined
        }
      >
        {content.priorReviewFindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No prior review findings (initial run).
          </p>
        ) : (
          <ol className="space-y-2">
            {content.priorReviewFindings.map((rf, idx) => (
              <li
                key={`${rf.reviewId}-${idx}`}
                className="rounded-md border border-border p-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge value={rf.verdict} />
                  <span className="font-mono text-muted-foreground">
                    review:{shortId(rf.reviewId)}
                  </span>
                  <span className="text-muted-foreground">{formatDateTime(rf.createdAt)}</span>
                </div>
                {rf.summary && <p className="mt-1">{rf.summary}</p>}
                {rf.findings.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {rf.findings.map((f, fi) => (
                      <li key={fi}>{f}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>

      {/* Instructions */}
      <Section
        title="Instructions"
        defaultOpen={defaultCollapsed}
        hint={content.instructions.length > 0 ? `(${content.instructions.length})` : undefined}
      >
        <ListItems items={content.instructions} />
      </Section>

      {/* Architecture content */}
      {(content.architectureContent || content.architectureName) && (
        <Section
          title="Architecture Content"
          defaultOpen={defaultCollapsed}
          hint={content.architectureName ? <span className="font-mono">{content.architectureName}</span> : undefined}
        >
          {content.architectureName && (
            <p className="mb-2 text-xs text-muted-foreground">{content.architectureName}</p>
          )}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs">
            {content.architectureContent ?? '—'}
          </pre>
        </Section>
      )}
    </div>
  );
}

export default ImplementationContextViewer;

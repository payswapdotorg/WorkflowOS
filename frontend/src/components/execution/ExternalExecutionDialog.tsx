import * as React from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  execution,
  type ExecutionSummary,
  type ExternalExecutionPackageView,
} from '@/api/client';

/**
 * WORK-027: External Execution handoff view (§15).
 *
 * Stage 1 (prepared): Provider / Work Item / Repository / Branch / Context
 * summary + [Prepare External Session].
 * Stage 2 (package): the one-time handoff token is issued (POST /handoff) and
 * immediately redeemed (GET /package with the x-handoff-token header). The
 * full package — prompt (expandable), verification requirements, callback
 * info — is shown. The token is kept in MEMORY ONLY (never localStorage) and
 * the package is never exposed through a public URL.
 *
 * The actual Companion-extension integration (driving Z.ai/ChatGPT/Claude
 * UIs) belongs to WORK-028/029 — WORK-027 proves the WorkflowOS side.
 */
export interface ExternalExecutionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  executionSummary: ExecutionSummary | null;
  onStatusChange?: () => void;
}

type Stage =
  | { phase: 'prepared' }
  | { phase: 'busy'; action: string }
  | { phase: 'package'; pkg: ExternalExecutionPackageView; status: string }
  | { phase: 'error'; message: string };

export function ExternalExecutionDialog({
  open, onOpenChange, executionSummary, onStatusChange,
}: ExternalExecutionDialogProps) {
  const [stage, setStage] = React.useState<Stage>({ phase: 'prepared' });
  const [promptExpanded, setPromptExpanded] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setStage({ phase: 'prepared' });
      setPromptExpanded(false);
    }
  }, [open, executionSummary?.executionId]);

  if (!executionSummary) return null;
  const ex = executionSummary;

  async function prepareExternalSession() {
    setStage({ phase: 'busy', action: 'Preparing external session…' });
    try {
      const issued = await execution.prepareHandoff(ex.executionId);
      // Redeem immediately (one-time) — the UI shows the package contents.
      const redeemed = await execution.getPackage(ex.executionId, issued.handoffToken);
      setStage({ phase: 'package', pkg: redeemed.package, status: redeemed.status });
      onStatusChange?.();
    } catch (err) {
      setStage({ phase: 'error', message: (err as Error).message });
      onStatusChange?.();
    }
  }

  const repository = ex.repository ?? '(not linked)';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            External Execution
            <Badge variant={ex.status === 'handoff_ready' || ex.status === 'submitted' ? 'default' : 'secondary'}>
              {ex.status === 'handoff_ready' ? 'Ready for external handoff' : ex.status}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            Secure handoff for the future WorkflowOS Companion extension. The
            package contains no credentials — your own session in the external
            platform drives execution.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-xs text-muted-foreground">Provider</span>
              <p className="font-medium">{ex.provider}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Execution</span>
              <p className="font-mono text-xs">{ex.executionId}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Repository</span>
              <p className="font-medium">{repository}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Context</span>
              <p className="font-medium">
                {ex.status === 'handoff_ready' ? 'Ready' : ex.status}
              </p>
            </div>
          </div>

          {stage.phase === 'prepared' && (
            <>
              <div>
                <span className="text-xs text-muted-foreground">Verification</span>
                <ul className="ml-4 list-disc text-xs">
                  <li>WorkflowOS observes authoritative GitHub / CI / verification / review state.</li>
                  <li>External execution can never declare merged / verified / pass / approved.</li>
                </ul>
              </div>
              <DialogFooter>
                <Button
                  onClick={prepareExternalSession}
                  disabled={ex.status !== 'handoff_ready' && ex.status !== 'submitted'}
                >
                  Prepare External Session
                </Button>
              </DialogFooter>
            </>
          )}

          {stage.phase === 'busy' && (
            <p className="text-xs text-muted-foreground">{stage.action}</p>
          )}

          {stage.phase === 'error' && (
            <p className="text-xs text-destructive">{stage.message}</p>
          )}

          {stage.phase === 'package' && (
            <>
              <div>
                <span className="text-xs text-muted-foreground">Branch</span>
                <p className="font-mono text-xs">{stage.pkg.branch}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Verification requirements</span>
                <ul className="ml-4 list-disc text-xs">
                  {stage.pkg.verificationRequirements.length === 0 && <li>(none specified)</li>}
                  {stage.pkg.verificationRequirements.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Return callback</span>
                <p className="font-mono text-xs">{stage.pkg.returnCallback.eventsPath}</p>
                <p className="text-xs text-muted-foreground">
                  events: {stage.pkg.returnCallback.eventTypes.join(' | ')}
                </p>
              </div>
              <div>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left"
                  onClick={() => setPromptExpanded((v) => !v)}
                  aria-expanded={promptExpanded}
                >
                  <span className="text-xs font-medium">Prompt (deterministic, generated by WorkflowOS)</span>
                  <span className="text-xs text-muted-foreground">{promptExpanded ? 'Collapse' : 'Expand'}</span>
                </button>
                {promptExpanded && (
                  <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
                    {stage.pkg.prompt}
                  </pre>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Package expires {new Date(stage.pkg.expiration).toLocaleString()}. The
                handoff token was consumed by this view — re-prepare to issue a
                fresh one. The Companion extension (WORK-028) will consume the
                package automatically — no copy/paste.
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ExternalExecutionDialog;

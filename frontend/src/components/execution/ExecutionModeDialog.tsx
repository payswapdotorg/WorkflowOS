import * as React from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { type ExecutionMode, type ExecutionProviderInfo } from '@/api/client';

/**
 * WORK-027: Start Implementation → Execution Mode dialog.
 *
 * ● Native   — Execute through a WorkflowOS provider (AgentGateway).
 * ○ External — Continue in an external AI platform (secure handoff package
 *              for the future Companion extension; WORK-028 wires the
 *              extension itself).
 *
 * The dialog surfaces provider readiness (native API configured vs external
 * UI available) as safe metadata from GET /agents/execution-providers. The
 * frontend holds NO provider secrets and implements NO provider-specific
 * logic — it only submits {mode, provider, model} to the backend, which owns
 * validation and execution.
 */
export interface ExecutionModeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workItemLabel: string;
  /** project-scoped capability list (falls back to the global list). */
  providers: ExecutionProviderInfo[];
  busy: boolean;
  error: string | null;
  onSubmit: (input: { mode: ExecutionMode; provider: string; model?: string }) => void;
}

/** WORK-030 (PR #33 review): readiness label for a provider surface. */
function surfaceLabel(readiness: 'ready' | 'unverified' | 'not-available'): string {
  if (readiness === 'ready') return 'Ready';
  if (readiness === 'unverified') return 'Unverified';
  return 'Not available';
}

function ReadinessRow({ p }: { p: ExecutionProviderInfo }) {
  return (
    <div className="rounded-md border px-3 py-1.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">{p.name}</span>
        <span className="flex items-center gap-1.5">
          <Badge variant={p.nativeApi === 'ready' ? 'default' : 'outline'} className="text-[10px]">
            Native: {p.nativeApi === 'ready' ? 'Configured' : 'Not configured'}
          </Badge>
          <Badge variant={p.externalUi === 'available' ? 'default' : 'outline'} className="text-[10px]">
            External: {p.externalUi === 'available' ? 'Available' : 'Not supported'}
          </Badge>
        </span>
      </div>
      {p.capabilities && (
        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>Conversational: {surfaceLabel(p.capabilities.conversationalChat)}</span>
          <span>Coding Agent: {surfaceLabel(p.capabilities.codingAgent)}</span>
        </div>
      )}
    </div>
  );
}

export function ExecutionModeDialog({
  open, onOpenChange, workItemLabel, providers, busy, error, onSubmit,
}: ExecutionModeDialogProps) {
  const [mode, setMode] = React.useState<ExecutionMode>('native');
  const nativeCandidates = providers.filter((p) => p.nativeApi === 'ready');
  const externalCandidates = providers.filter((p) => p.externalUi === 'available');
  const candidates = mode === 'native' ? nativeCandidates : externalCandidates;
  const [provider, setProvider] = React.useState<string>('');
  const [model, setModel] = React.useState<string>('');

  // Reset selection when the mode flips or the candidate list changes.
  React.useEffect(() => {
    if (candidates.length > 0 && !candidates.some((p) => p.provider === provider)) {
      setProvider(candidates[0]!.provider);
      const first = candidates[0];
      setModel(mode === 'native' ? first.model : '');
    } else if (candidates.length === 0) {
      setProvider('');
      setModel('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, providers]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start Implementation — {workItemLabel}</DialogTitle>
          <DialogDescription>
            Choose how this Work Order is executed. Both modes use the same
            authoritative WorkflowOS objects; the mode is an implementation
            detail.
          </DialogDescription>
        </DialogHeader>

        {/* Execution mode radios */}
        <div className="grid gap-3">
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
              mode === 'native' ? 'border-primary' : ''
            }`}
            aria-label="Native execution"
          >
            <input
              type="radio"
              name="execution-mode"
              className="mt-1"
              checked={mode === 'native'}
              onChange={() => setMode('native')}
            />
            <span>
              <span className="block text-sm font-medium">Native</span>
              <span className="block text-xs text-muted-foreground">
                Execute through a WorkflowOS provider (agent API).
              </span>
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
              mode === 'external' ? 'border-primary' : ''
            }`}
            aria-label="External execution"
          >
            <input
              type="radio"
              name="execution-mode"
              className="mt-1"
              checked={mode === 'external'}
              onChange={() => setMode('external')}
            />
            <span>
              <span className="block text-sm font-medium">External</span>
              <span className="block text-xs text-muted-foreground">
                Continue in an external AI platform via a secure handoff
                package (no WorkflowOS credentials required).
              </span>
            </span>
          </label>
        </div>

        {/* Provider readiness (safe metadata only) */}
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Provider readiness</span>
          <div className="grid max-h-36 gap-1.5 overflow-y-auto pr-1">
            {providers.map((p) => (
              <ReadinessRow key={p.provider} p={p} />
            ))}
          </div>
        </div>

        {/* Provider + model */}
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="execution-provider">Provider</Label>
            <select
              id="execution-provider"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                const next = candidates.find((p) => p.provider === e.target.value);
                setModel(mode === 'native' ? next?.model ?? '' : '');
              }}
            >
              {candidates.length === 0 && <option value="">(none available)</option>}
              {candidates.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {mode === 'native' && (
            <div className="grid gap-1.5">
              <Label htmlFor="execution-model">Model</Label>
              <Input
                id="execution-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model"
              />
            </div>
          )}
        </div>

        {mode === 'native' && nativeCandidates.length === 0 && (
          <p className="text-xs text-destructive">
            No native provider is configured. Ask your administrator to
            configure an implementation agent provider on the server, or
            configure a project provider under Integrations.
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => provider && onSubmit({ mode, provider, model: model || undefined })}
            disabled={busy || !provider || (mode === 'native' && !model)}
          >
            {busy ? 'Starting…' : 'Start Implementation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ExecutionModeDialog;

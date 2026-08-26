/**
 * WORK-039: NoOpHostInspector — the default governed host inspector.
 *
 * Returns NO observations + '[]' toolInvocationIds. The ranker works on
 * baseline evidence only. The capability NEVER claims an operation was
 * tool-governed when it was a direct baseline read (the no-fabrication
 * invariant — test invariant #14).
 *
 * When task-specific filesystem inspection IS required, a real
 * GovernedHostInspector implementation would:
 *   1. Acquire a WORK-035 Workspace (isolated worktree at the baseline commit
 *      via DefaultAgentWorkspaceService.acquireWorkspace).
 *   2. For every tool call, invoke WORK-036 ToolRuntime.invoke() — the
 *      ToolPolicyGate (WORK-037) is consulted; denied operations produce
 *      blocked observations (recorded honestly); the real toolInvocationId
 *      is captured.
 *   3. Return the observations + the HONEST toolInvocationIds (never
 *      fabricated; never a fake ID).
 *
 * That real implementation is a future slice (the WORK-039 prompt: "use these
 * primitives where task-specific filesystem inspection is required" —
 * conditional). The interface + the NoOp default + a test fake are sufficient
 * to prove invariants #13 (policy respected) + #14 (no fabricated evidence).
 */
import type {
  ContextIndexQuery,
  ContextResolutionContext,
  GovernedHostInspector,
  HostInspectionResult,
} from '../repository-intelligence.types.js';

export class NoOpHostInspector implements GovernedHostInspector {
  async inspect(
    _query: ContextIndexQuery,
    _ctx: ContextResolutionContext,
  ): Promise<HostInspectionResult> {
    // No host inspection — the ranker works on baseline evidence only. The
    // toolInvocationIds is '[]' (NEVER a fake ID — the no-fabrication
    // invariant). The capability NEVER claims an operation was tool-governed
    // when it was a direct baseline read.
    return { observations: [], toolInvocationIds: [] };
  }
}
